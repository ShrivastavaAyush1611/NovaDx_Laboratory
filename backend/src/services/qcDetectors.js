

const { localHour } = require('../utils');

const DEFAULT_SETTINGS = {
  baselineSize: 300,      
  truncateZ: 3,             
  windowSize: 40,           
  shiftLimit: 4.0,        
  cusumK: 0.5,             
  cusumH: 12,               
  disagreementLimit: 4.0,   
  disagreementMaxGapHours: 2, 
  lotWindowSize: 80,        
  lotLimit: 3.5,           
  cooldown: 100,            
  lateMinutes: 120          
};

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
  constructor(instrumentLabs, settings) {
    this.instrumentLabs = instrumentLabs || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    this.baselines = {};   
    this.streams = {};     
    this.pairCooldown = {}; 
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
        lotZ: [],            
        newLot: null,       
        newLotZ: [],
        previousLotZ: [],
        lateSkipped: 0,
        outliersSkipped: 0
      };
    }
    return this.streams[key];
  }

  process(result) {
    const s = this.settings;
    const signals = [];
    this.processedCount++;

    const time = new Date(result.timestamp);
    const block = timeBlock(localHour(result.timestamp));
    const baseline = this.getBaseline(result.analyte, block);
    const stream = this.getStream(result.instrument, result.analyte);

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

    const rawZ = (result.value - baseline.mean) / baseline.sd;
    if (Math.abs(rawZ) > s.truncateZ) {
      stream.outliersSkipped++;
      return signals;
    }
    const z = (rawZ - baseline.zMean) / baseline.zSd;

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

    if (stream.currentLot === null) stream.currentLot = result.reagent_lot;
    if (result.reagent_lot !== stream.currentLot && result.reagent_lot !== stream.newLot) {
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
        stream.newLot = null; 
      }
    }

    if (stream.window.length === s.windowSize) {
      const myLab = this.instrumentLabs[result.instrument];
      for (const key of Object.keys(this.streams)) {
        const other = this.streams[key];
        if (other === stream || other.analyte !== result.analyte) continue;
        if (!myLab || this.instrumentLabs[other.instrument] !== myLab) continue;
        if (other.window.length < s.windowSize) continue;
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
