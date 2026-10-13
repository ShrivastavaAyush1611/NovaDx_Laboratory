const request = require('supertest');
const { db, resetDatabase, makeMessage, auth } = require('./helpers');
const app = require('../src/app');
const { ingestMessage } = require('../src/services/ingestService');
const ruleSets = require('../src/services/ruleSets');
const ruleConfig = require('../config/rules/ruleset_v1.json');

async function fingerprint() {
  const res = await db.query(`
    SELECT
      (SELECT COUNT(*) FROM results) AS results,
      (SELECT COUNT(*) FROM decisions) AS decisions,
      (SELECT COUNT(*) FROM rule_sets) AS rule_sets,
      (SELECT md5(COALESCE(string_agg(r::text, ',' ORDER BY id), '')) FROM results r) AS results_hash,
      (SELECT md5(COALESCE(string_agg(d::text, ',' ORDER BY id), '')) FROM decisions d) AS decisions_hash,
      (SELECT md5(COALESCE(string_agg(rs::text, ',' ORDER BY version), '')) FROM rule_sets rs) AS rules_hash`);
  return res.rows[0];
}

function stricterRules() {
  const config = JSON.parse(JSON.stringify(ruleConfig));
  const critical = config.rules.find(function (r) { return r.id === 'K-CRITICAL'; });
  critical.high = 4.5; 
  return config;
}

beforeAll(async function () {
  await resetDatabase();
  const values = [3.9, 4.0, 4.2, 4.4, 4.6, 4.8, 5.0, 5.2, 6.5, 2.5];
  for (let i = 0; i < values.length; i++) {
    await ingestMessage(makeMessage({ patient: 'P-' + (100 + i), value: values[i], instrument: i % 2 ? 'INS-01' : 'INS-02' }), { skipQc: true });
  }
});

afterAll(async function () {
  await db.pool.end();
});

test('dry run reports changes and does NOT change any stored data', async function () {
  const before = await fingerprint();
  const res = await request(app).post('/api/rules/dry-run').set(auth('qe1')).send({ config: stricterRules() });
  expect(res.status).toBe(200);
  expect(res.body.total_results).toBe(10);
  expect(res.body.would_change).toBe(4);
  expect(res.body.changes['RELEASED -> HELD']).toBe(4);
  const after = await fingerprint();
  expect(after).toEqual(before);
});

test('dry run with the same rules changes nothing', async function () {
  const res = await request(app).post('/api/rules/dry-run').set(auth('qe1')).send({ config: ruleConfig });
  expect(res.body.would_change).toBe(0);
});

test('only a QualityEngineer may run a dry run', async function () {
  const res = await request(app).post('/api/rules/dry-run').set(auth('super1')).send({ config: ruleConfig });
  expect(res.status).toBe(403);
});

test('invalid rule set is refused', async function () {
  const res = await request(app).post('/api/rules/dry-run').set(auth('qe1')).send({ config: { rules: [{ id: 'X' }] } });
  expect(res.status).toBe(400);
});

test('saving a new rule set keeps the old version, new decisions use the new version', async function () {
  const res = await request(app).post('/api/rules').set(auth('qe1'))
    .send({ config: stricterRules(), description: 'stricter K', effective_from: '2026-01-02T00:00:00Z' });
  expect(res.status).toBe(201);
  expect(res.body.version).toBe(2);

  const list = await request(app).get('/api/rules').set(auth('tech1'));
  expect(list.body.versions.map(function (v) { return v.version; })).toEqual([1, 2]);
  expect(list.body.active_version).toBe(2);

  const outcome = await ingestMessage(makeMessage({ patient: 'P-999', value: 4.7 }), { skipQc: true });
  expect(outcome.decision.rule_set_version).toBe(2);
  expect(outcome.decision.outcome).toBe('HELD');

  const old = await db.query("SELECT result_id FROM decisions WHERE rule_set_version = 1 AND outcome = 'RELEASED' LIMIT 1");
  const resultRow = await db.query('SELECT lab_id FROM results WHERE id = $1', [old.rows[0].result_id]);
  const user = resultRow.rows[0].lab_id === 'LAB-1' ? 'tech1' : 'tech2';
  const rep = await request(app).get('/api/results/' + old.rows[0].result_id + '/reproduce').set(auth(user));
  expect(rep.body.rule_set_version).toBe(1);
  expect(rep.body.same).toBe(true);
});

test('a rule set with a future date is not active yet', async function () {
  await ruleSets.createRuleSet(ruleConfig, '2099-01-01T00:00:00Z', 'future', 'qe1');
  const active = await ruleSets.getActiveRuleSet(new Date());
  expect(active.version).toBe(2);
});

test('reproduce uses the recorded previous result, even if results arrived in a strange order', async function () {
  const newer = await ingestMessage(makeMessage({ patient: 'P-500', value: 4.0, timestamp: '2026-03-04T10:00:00+05:30' }), { skipQc: true });
  await ingestMessage(makeMessage({ patient: 'P-500', value: 6.5, timestamp: '2026-03-04T08:00:00+05:30' }), { skipQc: true });
  const rep = await request(app).get('/api/results/' + newer.result_id + '/reproduce').set(auth('tech1'));
  expect(rep.body.same).toBe(true);
  expect(rep.body.reproduced_outcome).toBe('RELEASED');
});

test('a REJECTED result is never used as the previous value for a delta check', async function () {
  await ingestMessage(makeMessage({ patient: 'P-600', value: 999999, timestamp: '2026-03-04T08:00:00+05:30' }), { skipQc: true });
  const next = await ingestMessage(makeMessage({ patient: 'P-600', value: 4.2, timestamp: '2026-03-04T10:00:00+05:30' }), { skipQc: true });
  expect(next.decision.outcome).toBe('RELEASED');
});
