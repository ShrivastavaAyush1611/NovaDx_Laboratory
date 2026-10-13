const { generate } = require('../src/simulator');
const { runEvaluation } = require('../src/qcEvaluation');
const { QcDetector } = require('../src/services/qcDetector');

const LABS = { 'INS-01': 'LAB-1', 'INS-02': 'LAB-1' };

describe('detection of the injected faults (50,000 simulated results)', function () {
  let report;

  beforeAll(function () {
    const data = generate({ results: 50000, seed: 42, faults: true });
    report = runEvaluation(data.messages, data.faults);
    console.log('Fault detection:\n' + report.faults.map(function (f) {
      return '  ' + f.id + ' ' + f.type + ': ' + (f.detected ? 'detected after ' + f.detection_delay_hours + ' h' : 'NOT detected');
    }).join('\n') + '\n  false alarms: ' + report.false_alarms);
  });

  function fault(id) {
    return report.faults.find(function (f) { return f.id === id; });
  }

  test('slow drift (F1) is detected within 36 hours', function () {
    expect(fault('F1').detected).toBe(true);
    expect(fault('F1').detection_delay_hours).toBeLessThan(36);
  });

  test('sudden shift (F2) is detected within 6 hours', function () {
    expect(fault('F2').detected).toBe(true);
    expect(fault('F2').detection_delay_hours).toBeLessThan(6);
  });

  test('faulty reagent lot (F3) is detected within 12 hours, also by the lot check', function () {
    expect(fault('F3').detected).toBe(true);
    expect(fault('F3').detection_delay_hours).toBeLessThan(12);
    expect(fault('F3').signal_types).toContain('LOT_SHIFT');
  });

  test('two instruments disagreeing is detected during the shift fault', function () {
    expect(fault('F2').signal_types).toContain('DISAGREEMENT');
  });

  test('false alarms on the data with faults are few', function () {
    expect(report.false_alarms).toBeLessThanOrEqual(5);
  });
});

describe('false alarm rate on data WITHOUT faults', function () {
  test('on average at most 1 false alarm per 10,000 results (all 5 held-out seeds)', function () {
    let falseAlarms = 0;
    let results = 0;
    for (const seed of [11, 12, 13, 14, 15]) {
      const clean = generate({ results: 50000, seed: seed, faults: false });
      const r = runEvaluation(clean.messages, []);
      falseAlarms += r.false_alarms;
      results += r.results_processed;
    }
    const per10000 = falseAlarms / results * 10000;
    console.log('Clean data: ' + falseAlarms + ' false alarms in ' + results + ' results (' + per10000.toFixed(2) + ' per 10,000)');
    expect(per10000).toBeLessThanOrEqual(1);
  });
});

describe('detector details', function () {
  function feed(detector, instrument, analyte, values, startMs, minutesBetween, lot) {
    const signals = [];
    values.forEach(function (v, i) {
      const t = new Date(startMs + i * minutesBetween * 60000 + 5.5 * 3600000);
      const ts = t.toISOString().substring(0, 19) + '+05:30';
      signals.push.apply(signals, detector.process({ id: i, instrument: instrument, analyte: analyte, value: v, reagent_lot: lot || 'L1', timestamp: ts }));
    });
    return signals;
  }

  function noise(n, mean, sd, seed) {
    const out = [];
    let x = seed || 1;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = 0; k < 12; k++) {
        x = (x * 1103515245 + 12345) % 2147483648;
        s += x / 2147483648;
      }
      out.push(mean + (s - 6) * sd);
    }
    return out;
  }

  test('no alarm while the baseline is still being learned (quiet period / startup)', function () {
    const det = new QcDetector(LABS);
    const signals = feed(det, 'INS-01', 'K', noise(100, 6.0, 0.3), Date.parse('2026-03-01T00:00:00Z'), 5);
    expect(signals).toEqual([]);
  });

  test('a normal day/night pattern does not cause alarms (baseline per time block)', function () {
    const det = new QcDetector(LABS);
    const start = Date.parse('2026-03-01T00:00:00Z') - 5.5 * 3600000; 
    let signals = [];
    const noiseList = noise(1440, 0, 0.3, 7);
    for (let i = 0; i < 1440; i++) {
      const t = start + i * 10 * 60000;
      const hour = new Date(t + 5.5 * 3600000).getUTCHours();
      const mean = hour < 6 ? 5.0 : 4.0;
      signals = signals.concat(feed(det, 'INS-01', 'K', [mean + noiseList[i]], t, 0));
    }
    expect(signals.filter(function (s) { return s.type === 'SHIFT' || s.type === 'DRIFT'; })).toEqual([]);
  });

  const MORNING = Date.parse('2026-03-01T00:30:00Z');

  test('a clear shift on one instrument is found quickly', function () {
    const det = new QcDetector(LABS);
    feed(det, 'INS-01', 'K', noise(400, 4.0, 0.3, 3), MORNING, 0.5);
    const signals = feed(det, 'INS-01', 'K', noise(100, 4.6, 0.3, 5), MORNING + 200 * 60000, 0.5);
    expect(signals.length).toBeGreaterThan(0);
    expect(['SHIFT', 'DRIFT']).toContain(signals[0].type);
  });
});
