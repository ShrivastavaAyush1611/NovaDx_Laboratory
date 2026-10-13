const fs = require('fs');
const path = require('path');
const { generate } = require('../src/simulator');

const args = process.argv.slice(2);
function getArg(name, defaultValue) {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  return defaultValue;
}

const clean = args.includes('--clean');
const results = parseInt(getArg('--results', '50000'), 10);
const seed = parseInt(getArg('--seed', clean ? '4242' : '42'), 10);

const data = generate({ results: results, seed: seed, faults: !clean });

const dataDir = path.join(__dirname, '../data');
const name = clean ? 'simulated_clean' : 'simulated_results';
const lines = data.messages.map(function (m) { 
    return JSON.stringify(m); 
}).join('\n') + '\n';
fs.writeFileSync(path.join(dataDir, name + '.jsonl'), lines);
fs.writeFileSync(path.join(dataDir, name + '_faults.json'), 
JSON.stringify({ faults: data.faults, stats: data.stats }, null, 2));


console.log('Wrote data/' + name + '.jsonl');
console.log(data.stats);
console.log('Injected faults:');
for (const f of data.faults) console.log('  ' + f.id + ' ' + f.type + ': ' + f.description + ' (' + f.start + ' -> ' + f.end + ')');
