
const request = require('supertest');
const { db, resetDatabase, addSecondLab, makeMessage, auth } = require('./helpers');
const app = require('../src/app');
const { ingestMessage } = require('../src/services/ingestService');

const ids = {};

beforeAll(async function () {
  await resetDatabase();
  await addSecondLab(); 
  ids.before = (await ingestMessage(makeMessage({ patient: 'P-1', instrument: 'INS-01', reagent_lot: 'LOT-BAD', timestamp: '2026-03-04T07:00:00+05:30' }), { skipQc: true })).result_id;
  ids.after1 = (await ingestMessage(makeMessage({ patient: 'P-2', instrument: 'INS-01', reagent_lot: 'LOT-BAD', timestamp: '2026-03-04T10:00:00+05:30' }), { skipQc: true })).result_id;
  ids.after2 = (await ingestMessage(makeMessage({ patient: 'P-3', instrument: 'INS-01', reagent_lot: 'LOT-BAD', timestamp: '2026-03-04T11:00:00+05:30' }), { skipQc: true })).result_id;
  ids.held = (await ingestMessage(makeMessage({ patient: 'P-4', instrument: 'INS-01', reagent_lot: 'LOT-BAD', value: 7.5, timestamp: '2026-03-04T11:30:00+05:30' }), { skipQc: true })).result_id;
  ids.otherLot = (await ingestMessage(makeMessage({ patient: 'P-5', instrument: 'INS-01', reagent_lot: 'LOT-GOOD', timestamp: '2026-03-04T11:00:00+05:30' }), { skipQc: true })).result_id;
  ids.lab2 = (await ingestMessage(makeMessage({ patient: 'P-6', instrument: 'INS-03', reagent_lot: 'LOT-BAD', timestamp: '2026-03-04T12:00:00+05:30' }), { skipQc: true })).result_id;
});

afterAll(async function () {
  await db.pool.end();
});

let caseId;

test('creating a case flags only RELEASED results of that lot after the start time', async function () {
  const res = await request(app).post('/api/impact').set(auth('qe1')).send({
    kind: 'reagent_lot', target: 'LOT-BAD', start_time: '2026-03-04T09:00:00+05:30', description: 'lot confirmed faulty'
  });
  expect(res.status).toBe(201);
  caseId = res.body.impact_case.id;

  expect(res.body.flagged_total).toBe(3);
  const flagged = await db.query('SELECT result_id FROM result_flags ORDER BY result_id');
  expect(flagged.rows.map(function (r) { return Number(r.result_id); }))
    .toEqual([Number(ids.after1), Number(ids.after2), Number(ids.lab2)]);
});

test('the report for LAB-1 only lists LAB-1 results', async function () {
  const res = await request(app).get('/api/impact/' + caseId + '/report').set(auth('super1'));
  expect(res.status).toBe(200);
  expect(res.body.lab.id).toBe('LAB-1');
  expect(res.body.summary.affected_results).toBe(2);
  expect(res.body.results.every(function (r) { return r.instrument === 'INS-01'; })).toBe(true);

  const res2 = await request(app).get('/api/impact/' + caseId + '/report').set(auth('super2'));
  expect(res2.body.summary.affected_results).toBe(1);
  expect(res2.body.results[0].instrument).toBe('INS-03');
});

test('a flagged result shows the flag', async function () {
  const res = await request(app).get('/api/results/' + ids.after1).set(auth('tech1'));
  expect(res.body.flags.length).toBe(1);
  expect(res.body.flags[0].flag).toBe('POTENTIALLY_AFFECTED');
});

test('instrument cases are only allowed for instruments of the own lab', async function () {
  const res = await request(app).post('/api/impact').set(auth('qe1')).send({ kind: 'instrument', target: 'INS-03', start_time: '2026-03-04T00:00:00Z' });
  expect(res.status).toBe(404);
});

test('a correction is a NEW version linked to the original; both stay visible', async function () {
  const res = await request(app).post('/api/results/' + ids.after1 + '/correct').set(auth('super1'))
    .send({ value: 4.6, reason: 'Re-measured with good lot after LOT-BAD recall' });
  expect(res.status).toBe(201);
  const corrected = res.body.corrected;
  expect(corrected.version).toBe(2);
  expect(Number(corrected.corrects_result_id)).toBe(Number(ids.after1));

  const original = await request(app).get('/api/results/' + ids.after1).set(auth('tech1'));
  expect(original.body.result.value).toBe(4.1);
  expect(original.body.is_current).toBe(false);
  expect(original.body.versions.map(function (v) { return v.version; })).toEqual([1, 2]);

  const list = await request(app).get('/api/results').set(auth('tech1'));
  const rows = list.body.filter(function (r) { return r.sample_id === original.body.result.sample_id; });
  expect(rows.length).toBe(1);
  expect(rows[0].value).toBe(4.6);
  expect(rows[0].version).toBe(2);

  const report = await request(app).get('/api/impact/' + caseId + '/report').set(auth('super1'));
  expect(report.body.summary.corrected).toBe(1);
  expect(report.body.summary.still_to_review).toBe(1);
});

test('corrections need a reason and only supervisors can issue them', async function () {
  expect((await request(app).post('/api/results/' + ids.after2 + '/correct').set(auth('super1')).send({ value: 4.6 })).status).toBe(400);
  expect((await request(app).post('/api/results/' + ids.after2 + '/correct').set(auth('tech1')).send({ value: 4.6, reason: 'x' })).status).toBe(403);
});
