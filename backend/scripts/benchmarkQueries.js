
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env'), quiet: true });

const baseUrl = 'http://localhost:' + (process.env.PORT || 5050);

async function login(username) {
  const res = await fetch(baseUrl + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: username, password: 'password123' })
  });
  return (await res.json()).token;
}

async function timeIt(name, token, method, url, body) {
  const times = [];
  for (let i = 0; i < 10; i++) {
    const t0 = process.hrtime.bigint();
    const res = await fetch(baseUrl + url, {
      method: method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: body ? JSON.stringify(body) : undefined
    });
    await res.text();
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    if (method === 'POST') break; 
  }
  times.sort(function (a, b) { return a - b; });
  const median = times[Math.floor(times.length / 2)];
  console.log('  ' + name.padEnd(45) + median.toFixed(1).padStart(8) + ' ms');
}

async function main() {
  const tech = await login('tech1');
  const sup = await login('super1');
  const qe = await login('qe1');
  const aud = await login('auditor1');

  const firstResult = await (await fetch(baseUrl + '/api/results', { headers: { Authorization: 'Bearer ' + tech } })).json();
  const rules = await (await fetch(baseUrl + '/api/rules/1', { headers: { Authorization: 'Bearer ' + qe } })).json();

  console.log('Median time over 10 calls (dry-run: 1 call)');
  await timeIt('GET /api/results (latest 50)', tech, 'GET', '/api/results?limit=50');
  await timeIt('GET /api/results?outcome=HELD', tech, 'GET', '/api/results?outcome=HELD&limit=50');
  await timeIt('GET /api/results?search=P-10001 (patient)', tech, 'GET', '/api/results?search=P-10001&limit=50');
  await timeIt('GET /api/results/summary', tech, 'GET', '/api/results/summary');
  await timeIt('GET /api/results/:id', tech, 'GET', '/api/results/' + firstResult[0].id);
  await timeIt('GET /api/review/queue', sup, 'GET', '/api/review/queue');
  await timeIt('GET /api/alerts', tech, 'GET', '/api/alerts');
  await timeIt('GET /api/qc/moving-average?analyte=K', tech, 'GET', '/api/qc/moving-average?analyte=K&window=50');
  await timeIt('GET /api/audit/verify', aud, 'GET', '/api/audit/verify');
  await timeIt('POST /api/rules/dry-run (all stored results)', qe, 'POST', '/api/rules/dry-run', { config: rules.config });
}

main().catch(function (err) {
  console.error('Benchmark failed (is the server running?)', err.message);
  process.exit(1);
});
