const fs = require('fs');
const path = require('path');
const { generate } = require('../src/simulator');
const { runEvaluation } = require('../src/qcEvaluation');

function printReport(title, report) {
  console.log('\n==== ' + title + ' ====');
  console.log('Results processed: ' + report.results_processed + ' over ' + report.days_covered + ' days');
  console.log('Signals raised:    ' + report.total_signals);
  if (report.faults_total > 0) {
    console.log('Faults detected:   ' + report.faults_detected + ' of ' + report.faults_total);
    for (const f of report.faults) {
      if (f.detected) {
        console.log('  ' + f.id + ' ' + f.type.padEnd(6) + ' DETECTED after ' + f.detection_delay_hours + ' h by ' +
          f.first_signal_type + ' (signal types: ' + f.signal_types.join(', ') + ')');
      } else {
        console.log('  ' + f.id + ' ' + f.type.padEnd(6) + ' NOT detected  - ' + f.description);
      }
    }
  }
  console.log('False alarms:      ' + report.false_alarms + ' (' + report.false_alarms_per_10000_results + ' per 10,000 results) ' +
    JSON.stringify(report.false_alarms_by_type));
  for (const fa of report.false_alarm_examples) {
    console.log('    ' + fa.time + '  ' + fa.type + '  ' + fa.message);
  }
}

const withFaults = generate({ results: 50000, seed: 42, faults: true });
const reportFaults = runEvaluation(withFaults.messages, withFaults.faults);
printReport('Data WITH injected faults (seed 42)', reportFaults);

const cleanRuns = [];
const tuningSeeds = [4242, 1001, 2002, 7, 8];
const heldOutSeeds = [11, 12, 13, 14, 15];
for (const seed of tuningSeeds.concat(heldOutSeeds)) {
  const cleanData = generate({ results: 50000, seed: seed, faults: false });
  const reportClean = runEvaluation(cleanData.messages, []);
  if (seed === 4242) {
    printReport('Data WITHOUT faults (seed ' + seed + ') - every signal is a false alarm', reportClean);
  }
  cleanRuns.push({
    seed: seed,
    held_out: heldOutSeeds.includes(seed),
    false_alarms: reportClean.false_alarms,
    per_10000: reportClean.false_alarms_per_10000_results,
    by_type: reportClean.false_alarms_by_type
  });
}
console.log('\n==== False alarms on clean data (50,000 results / 14 days each) ====');
for (const run of cleanRuns) {
  console.log('  seed ' + String(run.seed).padEnd(5) + (run.held_out ? ' (held out)' : ' (tuning)  ') + '  false alarms: ' +
    String(run.false_alarms).padEnd(3) + JSON.stringify(run.by_type));
}
function avg(list) { return list.reduce(function (a, b) { return a + b; }, 0) / list.length; }
const tuneAvg = avg(cleanRuns.filter(function (r) { return !r.held_out; }).map(function (r) { return r.false_alarms; }));
const heldAvg = avg(cleanRuns.filter(function (r) { return r.held_out; }).map(function (r) { return r.false_alarms; }));
console.log('  average per 14 days: tuning seeds ' + tuneAvg.toFixed(1) + ', held-out seeds ' + heldAvg.toFixed(1));

const outFile = path.join(__dirname, '../data/evaluation_report.json');
fs.writeFileSync(outFile, JSON.stringify({ with_faults: reportFaults, clean_runs: cleanRuns }, null, 2));
console.log('\nFull report written to data/evaluation_report.json');
