
const db = require('../db');
const { QcDetector } = require('./qcDetector');
const { raiseAlert } = require('./alertService');

let detector = null;

async function init() {
  const instruments = await db.query('SELECT id, lab_id FROM instruments');
  const labs = {};
  for (const row of instruments.rows) labs[row.id] = row.lab_id;
  const newDetector = new QcDetector(labs);

  const res = await db.query(
    'SELECT id, instrument, analyte, value, reagent_lot, original_timestamp FROM results WHERE version = 1 ORDER BY id'
  );
  for (const r of res.rows) {
    newDetector.process({
      id: r.id, instrument: r.instrument, analyte: r.analyte, value: r.value,
      reagent_lot: r.reagent_lot, timestamp: r.original_timestamp
    });
  }
  detector = newDetector;
  return res.rows.length;
}

function reset() {
  detector = null;
}

function getDetector() {
  return detector;
}

async function processResult(result) {
  if (result.version > 1) return [];

  if (!detector) {
    await init();
    return [];
  }

  const signals = detector.process({
    id: result.id,
    instrument: result.instrument,
    analyte: result.analyte,
    value: result.value,
    reagent_lot: result.reagent_lot,
    timestamp: result.original_timestamp
  });

  for (const signal of signals) {
    await raiseAlert(signal);
  }
  return signals;
}

async function getMovingAverage(labId, analyte, windowSize) {
  windowSize = windowSize || 50;
  
  const res = await db.query(
    `SELECT r.instrument, r.value, r.collected_at FROM results r
     JOIN decisions d ON d.result_id = r.id AND d.seq = 1
     WHERE r.lab_id = $1 AND r.analyte = $2 AND r.version = 1 AND d.outcome <> 'REJECTED'
     ORDER BY r.collected_at`,
    [labId, analyte]
  );
  const byInstrument = {};
  for (const row of res.rows) {
    if (!byInstrument[row.instrument]) byInstrument[row.instrument] = [];
    byInstrument[row.instrument].push(row);
  }
  const series = {};
  for (const instrument of Object.keys(byInstrument)) {
    const rows = byInstrument[instrument];
    const points = [];
    let sum = 0;
    for (let i = 0; i < rows.length; i++) {
      sum += rows[i].value;
      if (i >= windowSize) sum -= rows[i - windowSize].value;
      if (i >= windowSize - 1) {
        points.push({ t: new Date(rows[i].collected_at).getTime(), avg: Number((sum / windowSize).toFixed(3)) });
      }
    }
    const step = Math.max(1, Math.ceil(points.length / 400));
    series[instrument] = points.filter(function (p, i) { return i % step === 0; });
  }
  return { analyte: analyte, window: windowSize, series: series };
}

module.exports = { init, reset, getDetector, processResult, getMovingAverage };
