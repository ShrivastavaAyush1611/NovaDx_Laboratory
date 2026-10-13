
const { QcDetector } = require('./services/qcDetector');
const { validateMessage } = require('./services/validate');
const labsConfig = require('../config/labs.json');

const GRACE_HOURS = 6; 

function instrumentLabMap() {
  const map = {};
  for (const ins of labsConfig.instruments) map[ins.id] = ins.lab_id;
  return map;
}

function faultInstruments(fault) {
  return fault.instruments || [fault.instrument];
}

function signalMatchesFault(signal, fault) {
  if (signal.analyte !== fault.analyte) return false;
  const t = Date.parse(signal.time);
  if (t < Date.parse(fault.start) || t > Date.parse(fault.end) + GRACE_HOURS * 3600000) return false;
  const signalInstruments = [signal.instrument, signal.other_instrument].filter(Boolean);
  return signalInstruments.some(function (i) { return faultInstruments(fault).includes(i); });
}

function runEvaluation(messages, faults, settings) {
  const detector = new QcDetector(instrumentLabMap(), settings);
  const seen = {};
  const signals = [];
  const known = instrumentLabMap();
  let processed = 0;
  let firstTime = null;
  let lastTime = null;

  for (const msg of messages) {
    if (validateMessage(msg).length > 0) continue;   // dead letter
    if (!known[msg.instrument]) continue;            // dead letter
    const key = msg.sample_id + '|' + msg.analyte;
    if (seen[key]) continue;                         // duplicate
    seen[key] = true;
    processed++;
    const t = Date.parse(msg.timestamp);
    if (firstTime === null || t < firstTime) firstTime = t;
    if (lastTime === null || t > lastTime) lastTime = t;
    const found = detector.process({
      id: processed, instrument: msg.instrument, analyte: msg.analyte, value: msg.value,
      reagent_lot: msg.reagent_lot, timestamp: msg.timestamp
    });
    for (const s of found) signals.push(s);
  }

  const faultReport = faults.map(function (fault) {
    const matching = signals.filter(function (s) { return signalMatchesFault(s, fault); });
    matching.sort(function (a, b) { return Date.parse(a.time) - Date.parse(b.time); });
    const first = matching[0];
    return {
      id: fault.id,
      type: fault.type,
      description: fault.description,
      detected: Boolean(first),
      first_signal_type: first ? first.type : null,
      detection_delay_hours: first ? Number(((Date.parse(first.time) - Date.parse(fault.start)) / 3600000).toFixed(1)) : null,
      signals_during_fault: matching.length,
      signal_types: Array.from(new Set(matching.map(function (s) { return s.type; })))
    };
  });

  const falseAlarms = signals.filter(function (s) {
    return !faults.some(function (f) { return signalMatchesFault(s, f); });
  });

  const days = lastTime && firstTime ? (lastTime - firstTime) / 86400000 : 0;
  const falseByType = {};
  for (const s of falseAlarms) falseByType[s.type] = (falseByType[s.type] || 0) + 1;

  return {
    results_processed: processed,
    days_covered: Number(days.toFixed(1)),
    total_signals: signals.length,
    faults: faultReport,
    faults_detected: faultReport.filter(function (f) { return f.detected; }).length,
    faults_total: faultReport.length,
    false_alarms: falseAlarms.length,
    false_alarms_by_type: falseByType,
    false_alarms_per_10000_results: processed ? Number((falseAlarms.length / processed * 10000).toFixed(2)) : 0,
    false_alarm_examples: falseAlarms.slice(0, 10).map(function (s) {
      return { type: s.type, time: s.time, message: s.message };
    }),
    baselines: detector.getBaselines()
  };
}

module.exports = { runEvaluation, signalMatchesFault, GRACE_HOURS };
