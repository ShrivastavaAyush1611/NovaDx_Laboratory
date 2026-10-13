const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env'), quiet: true });

const args = process.argv.slice(2);
function getArg(name, defaultValue) {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  return defaultValue;
}

const file = path.resolve(path.join(__dirname, '..'), getArg('--file', 'data/simulated_results.jsonl'));
const concurrency = parseInt(getArg('--concurrency', '8'), 10);
const baseUrl = getArg('--url', 'http://localhost:' + (process.env.PORT || 5050));
const apiKey = process.env.INGEST_API_KEY || 'analyzer-key-123';

async function main() {
  if (!fs.existsSync(file)) {
    console.log('File not found: ' + file + '\nRun "npm run simulate" first.');
    process.exit(1);
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(function (l) { return l.trim() !== ''; });
  console.log('Sending ' + lines.length + ' messages to ' + baseUrl + ' with ' + concurrency + ' parallel senders...');

  const counts = { stored: 0, duplicate: 0, dead_letter: 0, error: 0 };
  const latencies = [];
  let next = 0;
  const started = Date.now();

  async function sender() {
    while (next < lines.length) {
      const line = lines[next];
      next++;
      const t0 = Date.now();
      try {
        const res = await fetch(baseUrl + '/api/ingest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
          body: line
        });
        const body = await res.json();
        if (counts[body.status] !== undefined) counts[body.status]++;
        else counts.error++;
      } catch (err) {
        counts.error++;
      }
      latencies.push(Date.now() - t0);
      if (next % 5000 === 0) {
        console.log('  ' + next + ' sent (' + ((Date.now() - started) / 1000).toFixed(1) + ' s)');
      }
    }
  }

  const senders = [];
  for (let i = 0; i < concurrency; i++) senders.push(sender());
  await Promise.all(senders);

  const seconds = (Date.now() - started) / 1000;
  latencies.sort(function (a, b) { return a - b; });
  const p = function (q) { return latencies[Math.floor((latencies.length - 1) * q)]; };
  console.log('\nDone in ' + seconds.toFixed(1) + ' s  (' + Math.round(lines.length / seconds) + ' messages per second)');
  console.log('Outcome: ' + JSON.stringify(counts));
  console.log('Latency per message: p50 ' + p(0.5) + ' ms, p95 ' + p(0.95) + ' ms, p99 ' + p(0.99) + ' ms, max ' + latencies[latencies.length - 1] + ' ms');
}

main();
