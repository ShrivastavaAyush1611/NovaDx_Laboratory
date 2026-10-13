// Patient based quality control ("average of normals").
// This file has NO database code, so the same detector is used by the server,
// the tests and the evaluation script.
//
// How it works (simple version):
// 1. Baseline: for every analyte and time-of-day block we learn the normal mean and SD
//    from the first results (all instruments together). Different blocks handle the
//    normal daily pattern (e.g. more sick inpatients at night).
// 2. Every result becomes a z-score: (value - baseline median) / baseline SD.
//    Very abnormal patients (|z| > truncateZ) are left out, they say nothing about the instrument.
//    The z-score is then calibrated so that normal data has mean 0 and SD 1 (see computeBaseline).
// 3. Per instrument + analyte we keep the last N z-scores (moving window, counted in results
//    not in hours, so quiet periods just take longer to fill the window).
// 4. Checks:
//    SHIFT        -> moving average of the window is too far from 0
//    DRIFT        -> CUSUM (adds up small deviations over time, good for slow drifts)
//    DISAGREEMENT -> two instruments of the same lab running the same test have different averages
//    LOT_SHIFT    -> the first results of a new reagent lot differ from the previous lot

const { localHour } = require('../utils');

const DEFAULT_SETTINGS = {
  baselineSize: 300,        // results needed (per analyte per block) to learn the baseline
  truncateZ: 3,             // ignore results further than this from the baseline
  windowSize: 40,           // moving window size (number of results)
  shiftLimit: 4.0,          // SHIFT if |window mean| > shiftLimit * standard error
  cusumK: 0.5,              // CUSUM allowance (in SD)
  cusumH: 12,               // CUSUM decision limit (tuned, see README)
  disagreementLimit: 4.0,   // DISAGREEMENT if |meanA - meanB| > limit * standard error
  disagreementMaxGapHours: 2, // only compare instruments that both had results recently
  lotWindowSize: 80,        // results of the new lot to collect before comparing
  lotLimit: 3.5,            // LOT_SHIFT if difference > lotLimit * standard error
  cooldown: 100,            // after a signal, wait this many results before the same signal again
  lateMinutes: 120          // results older than this (compared to the newest one) are skipped
};

// 4 blocks of 6 hours (lab local time)
function timeBlock(hour) {
  if (hour < 6) return 'night';
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  return 'evening';
}

function average(list) {
  let sum = 0;
  for (const x of list) sum += x;
  return sum / list.length;
}

function percentile(sorted, p) {
  const index = Math.round((sorted.length - 1) * p);
  return sorted[index];
}

// "robust" mean and SD: median as the center and the spread between the 16th and 84th
// percentile as the SD. Sick patients (long tail on one side) don't pull this around much.
// (first version used a trimmed mean, that gave false alarms for sodium - see README)
// Step 2: we only use results with |z| <= truncateZ, so we also remember the mean and SD
// of those truncated z-scores (zMean, zSd). Then (z - zMean) / zSd has mean 0 and SD 1
// in normal conditions, and the limits below mean the same thing for every analyte.
function computeBaseline(values, truncateZ) {
  const sorted = values.slice().sort(function (a, b) { return a - b; });
  const median = percentile(sorted, 0.5);
  let sd = (percentile(sorted, 0.84) - percentile(sorted, 0.16)) / 2;
  if (sd <= 0) sd = 1e-6;

  const kept = [];
  for (const v of values) {
    const z = (v - median) / sd;
    if (Math.abs(z) <= truncateZ) kept.push(z);
  }
  const zMean = average(kept);
  let sq = 0;
  for (const z of kept) sq += (z - zMean) * (z - zMean);
  let zSd = Math.sqrt(sq / (kept.length - 1));
  if (!(zSd > 0)) zSd = 1;
  return { mean: median, sd: sd, zMean: zMean, zSd: zSd };
}

class QcDetector {
  // instrumentLabs = { 'INS-01': 'LAB-1', ... }
  constructor(instrumentLabs, settings) {
    this.instrumentLabs = instrumentLabs || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    this.baselines = {};   // analyte -> block -> { mean, sd, ready, learning: [] }
    this.streams = {};     // "INS-01|K" -> state of that instrument + analyte
    this.pairCooldown = {}; // "K|INS-01|INS-02" -> count at last signal
    this.processedCount = 0;
  }

  getBaseline(analyte, block) {
    if (!this.baselines[analyte]) this.baselines[analyte] = {};
    if (!this.baselines[analyte][block]) {
      this.baselines[analyte][block] = { ready: false, learning: [] };
    }
    return this.baselines[analyte][block];
  }

  getStream(instrument, analyte) {
    const key = instrument + '|' + analyte;
    if (!this.streams[key]) {
      this.streams[key] = {
        instrument: instrument,
        analyte: analyte,
        count: 0,
        window: [],
        cusumHigh: 0,
        cusumLow: 0,
        lastTime: null,
        lastShiftAt: -Infinity,
        lastDriftAt: -Infinity,
        currentLot: null,
        lotZ: [],            // z values of the current lot (last lotWindowSize)
        newLot: null,        // a lot change we are still checking
        newLotZ: [],
        previousLotZ: [],
        lateSkipped: 0,
        outliersSkipped: 0
      };
    }
    return this.streams[key];
  }

  // result = { id, instrument, analyte, value, reagent_lot, timestamp (text with timezone) }
  // returns a list of signals (empty most of the time)
  process(result) {
    const s = this.settings;
    const signals = [];
    this.processedCount++;

    const time = new Date(result.timestamp);
    const block = timeBlock(localHour(result.timestamp));
    const baseline = this.getBaseline(result.analyte, block);
    const stream = this.getStream(result.instrument, result.analyte);

    // still learning the baseline
    if (!baseline.ready) {
      baseline.learning.push(result.value);
      if (baseline.learning.length >= s.baselineSize) {
        Object.assign(baseline, computeBaseline(baseline.learning, s.truncateZ));
        baseline.ready = true;
        baseline.learning = [];
      }
      stream.currentLot = result.reagent_lot;
      return signals;
    }

    // outliers are checked BEFORE we look at the time. A crazy value with a wrong
    // timestamp must not move the stream clock (bug found with the simulator)
    const rawZ = (result.value - baseline.mean) / baseline.sd;
    if (Math.abs(rawZ) > s.truncateZ) {
      stream.outliersSkipped++;
      return signals;
    }
    const z = (rawZ - baseline.zMean) / baseline.zSd;

    // late arriving result: it belongs to a window we already moved past
    if (stream.lastTime && time < stream.lastTime - s.lateMinutes * 60000) {
      stream.lateSkipped++;
      return signals;
    }
    if (!stream.lastTime || time > stream.lastTime) {
      stream.lastTime = time;
    }

    stream.count++;
    stream.window.push(z);
    if (stream.window.length > s.windowSize) stream.window.shift();

    const base = {
      instrument: result.instrument,
      analyte: result.analyte,
      reagent_lot: result.reagent_lot,
      lab_id: this.instrumentLabs[result.instrument] || null,
      result_id: result.id,
      time: time.toISOString()
    };

    // ---- SHIFT: moving average ----
    if (stream.window.length === s.windowSize && stream.count - stream.lastShiftAt >= s.cooldown) {
      const meanZ = average(stream.window);
      const se = 1 / Math.sqrt(s.windowSize);
      if (Math.abs(meanZ) > s.shiftLimit * se) {
        stream.lastShiftAt = stream.count;
        const direction = meanZ > 0 ? 'up' : 'down';
        signals.push(Object.assign({}, base, {
          type: 'SHIFT',
          score: meanZ,
          message: result.analyte + ' on ' + result.instrument + ': moving average shifted ' + direction +
            ' by ' + Math.abs(meanZ).toFixed(2) + ' SD (last ' + s.windowSize + ' results)'
        }));
      }
    }

    // ---- DRIFT: CUSUM ----
    stream.cusumHigh = Math.max(0, stream.cusumHigh + z - s.cusumK);
    stream.cusumLow = Math.max(0, stream.cusumLow - z - s.cusumK);
    if (stream.cusumHigh > s.cusumH || stream.cusumLow > s.cusumH) {
      const direction = stream.cusumHigh > s.cusumH ? 'upward' : 'downward';
      const score = stream.cusumHigh > s.cusumH ? stream.cusumHigh : -stream.cusumLow;
      stream.cusumHigh = 0;
      stream.cusumLow = 0;
      if (stream.count - stream.lastDriftAt >= s.cooldown) {
        stream.lastDriftAt = stream.count;
        signals.push(Object.assign({}, base, {
          type: 'DRIFT',
          score: score,
          message: result.analyte + ' on ' + result.instrument + ': slow ' + direction + ' drift detected (CUSUM ' + Math.abs(score).toFixed(1) + ')'
        }));
      }
    }

    // ---- LOT_SHIFT: new reagent lot ----
    if (stream.currentLot === null) stream.currentLot = result.reagent_lot;
    if (result.reagent_lot !== stream.currentLot && result.reagent_lot !== stream.newLot) {
      // a new lot was just put into use
      stream.previousLotZ = stream.lotZ.slice();
      stream.newLot = result.reagent_lot;
      stream.newLotZ = [];
      stream.lotZ = [];
      stream.currentLot = result.reagent_lot;
    }
    stream.lotZ.push(z);
    if (stream.lotZ.length > s.lotWindowSize) stream.lotZ.shift();

    if (stream.newLot === result.reagent_lot) {
      stream.newLotZ.push(z);
      if (stream.newLotZ.length === s.lotWindowSize) {
        // the new lot must be different from the previous lot AND from the normal baseline.
        // (if we replace a BAD lot with a good one, the results go back to normal -> no alarm)
        const newMean = average(stream.newLotZ);
        const seBaseline = 1 / Math.sqrt(s.lotWindowSize);
        let diff = newMean;
        let differentFromPrevious = true;
        if (stream.previousLotZ.length >= 20) {
          diff = newMean - average(stream.previousLotZ);
          const sePrevious = Math.sqrt(1 / s.lotWindowSize + 1 / stream.previousLotZ.length);
          differentFromPrevious = Math.abs(diff) > s.lotLimit * sePrevious;
        }
        const differentFromBaseline = Math.abs(newMean) > s.lotLimit * seBaseline;
        if (differentFromPrevious && differentFromBaseline) {
          signals.push(Object.assign({}, base, {
            type: 'LOT_SHIFT',
            score: diff,
            message: 'Reagent lot ' + result.reagent_lot + ' (' + result.analyte + ' on ' + result.instrument + '): results differ by ' +
              diff.toFixed(2) + ' SD from the previous lot'
          }));
        }
        stream.newLot = null; // check done
      }
    }

    // ---- DISAGREEMENT between instruments of the same lab ----
    if (stream.window.length === s.windowSize) {
      const myLab = this.instrumentLabs[result.instrument];
      for (const key of Object.keys(this.streams)) {
        const other = this.streams[key];
        if (other === stream || other.analyte !== result.analyte) continue;
        if (!myLab || this.instrumentLabs[other.instrument] !== myLab) continue;
        if (other.window.length < s.windowSize) continue;
        // quiet period: other instrument has no recent results, don't compare old data
        if (!other.lastTime || Math.abs(time - other.lastTime) > s.disagreementMaxGapHours * 3600000) continue;

        const pair = [stream.instrument, other.instrument].sort();
        const pairKey = result.analyte + '|' + pair.join('|');
        const last = this.pairCooldown[pairKey];
        if (last !== undefined && this.processedCount - last < s.cooldown * 4) continue;

        const diff = average(stream.window) - average(other.window);
        const se = Math.sqrt(2 / s.windowSize);
        if (Math.abs(diff) > s.disagreementLimit * se) {
          this.pairCooldown[pairKey] = this.processedCount;
          signals.push(Object.assign({}, base, {
            type: 'DISAGREEMENT',
            instrument: pair[0],
            other_instrument: pair[1],
            score: diff,
            message: result.analyte + ': ' + stream.instrument + ' and ' + other.instrument + ' disagree by ' +
              Math.abs(diff).toFixed(2) + ' SD'
          }));
        }
      }
    }

    return signals;
  }

  // small summary for the UI / API
  getStatus() {
    const out = [];
    for (const key of Object.keys(this.streams)) {
      const st = this.streams[key];
      out.push({
        instrument: st.instrument,
        analyte: st.analyte,
        lab_id: this.instrumentLabs[st.instrument] || null,
        results_in_qc: st.count,
        window_mean_sd: st.window.length ? Number(average(st.window).toFixed(3)) : null,
        window_size: st.window.length,
        cusum_high: Number(st.cusumHigh.toFixed(2)),
        cusum_low: Number(st.cusumLow.toFixed(2)),
        current_lot: st.currentLot,
        last_result_time: st.lastTime ? st.lastTime.toISOString() : null,
        late_skipped: st.lateSkipped,
        outliers_skipped: st.outliersSkipped
      });
    }
    return out;
  }

  getBaselines() {
    const out = [];
    for (const analyte of Object.keys(this.baselines)) {
      for (const block of Object.keys(this.baselines[analyte])) {
        const b = this.baselines[analyte][block];
        out.push({ analyte: analyte, block: block, ready: b.ready, median: b.mean, sd: b.sd, z_mean: b.zMean, z_sd: b.zSd, learned_so_far: b.learning.length });
      }
    }
    return out;
  }
}

module.exports = { QcDetector, DEFAULT_SETTINGS, timeBlock };
