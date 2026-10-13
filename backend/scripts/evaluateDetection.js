
const fs = require('fs');
const path = require('path');
const { generate } = require('../src/simulator');
const { runEvaluation } = require('../src/qcEvaluation');


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
function avg(list) { return list.reduce(function (a, b) { return a + b; }, 0) / list.length; }
const tuneAvg = avg(cleanRuns.filter(function (r) { return !r.held_out; }).map(function (r) { return r.false_alarms; }));
const heldAvg = avg(cleanRuns.filter(function (r) { return r.held_out; }).map(function (r) { return r.false_alarms; }));

const outFile = path.join(__dirname, '../data/evaluation_report.json');
fs.writeFileSync(outFile, JSON.stringify({ with_faults: reportFaults, clean_runs: cleanRuns }, null, 2));
