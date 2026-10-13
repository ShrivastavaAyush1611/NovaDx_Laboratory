const request = require('supertest');
const { db, resetDatabase, makeMessage, count } = require('./helpers');
const app = require('../src/app');
const { ingestMessage } = require('../src/services/ingestService');

const KEY = { 'x-api-key': 'analyzer-key-123', 'Content-Type': 'application/json' };

beforeEach(async function () {
  await resetDatabase();
});

afterAll(async function () {
  await db.pool.end();
});

describe('exactly-once storage', function () {
  test('a valid message is stored with a decision', async function () {
    const res = await request(app).post('/api/ingest').set(KEY).send(JSON.stringify(makeMessage()));
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('stored');
    expect(res.body.decision.outcome).toBe('RELEASED');
    expect(await count('results')).toBe(1);
    expect(await count('decisions')).toBe(1);
  });

  test('the same message sent twice is stored once', async function () {
    const msg = makeMessage();
    const first = await request(app).post('/api/ingest').set(KEY).send(JSON.stringify(msg));
    const second = await request(app).post('/api/ingest').set(KEY).send(JSON.stringify(msg));
    expect(first.body.status).toBe('stored');
    expect(second.status).toBe(200);
    expect(second.body.status).toBe('duplicate');
    expect(second.body.result_id).toBe(first.body.result_id);
    expect(await count('results')).toBe(1);
    expect(await count('decisions')).toBe(1);
    expect(await count('duplicate_messages')).toBe(1);
  });

  test('20 copies arriving at the same moment are stored exactly once', async function () {
    const msg = makeMessage();
    const promises = [];
    for (let i = 0; i < 20; i++) {
      promises.push(ingestMessage(Object.assign({}, msg), { skipQc: true }));
    }
    const outcomes = await Promise.all(promises);
    const stored = outcomes.filter(function (o) { return o.status === 'stored'; });
    const duplicates = outcomes.filter(function (o) { return o.status === 'duplicate'; });
    expect(stored.length).toBe(1);
    expect(duplicates.length).toBe(19);
    expect(await count('results')).toBe(1);
    expect(await count('decisions')).toBe(1);
  });

  test('10 copies over HTTP at the same moment are stored exactly once', async function () {
    const body = JSON.stringify(makeMessage());
    const responses = await Promise.all(Array.from({ length: 10 }, function () {
      return request(app).post('/api/ingest').set(KEY).send(body);
    }));
    const statuses = responses.map(function (r) { return r.body.status; }).sort();
    expect(statuses.filter(function (s) { return s === 'stored'; }).length).toBe(1);
    expect(statuses.filter(function (s) { return s === 'duplicate'; }).length).toBe(9);
    expect(await count('results')).toBe(1);
  });

  test('same sample+analyte with DIFFERENT content does not overwrite, goes to dead letters', async function () {
    const msg = makeMessage({ value: 4.1 });
    await ingestMessage(msg, { skipQc: true });
    const changed = Object.assign({}, msg, { value: 5.9 });
    const outcome = await ingestMessage(changed, { skipQc: true });
    expect(outcome.status).toBe('dead_letter');
    expect(outcome.reason).toMatch(/conflicting duplicate/);
    const stored = await db.query('SELECT value FROM results');
    expect(stored.rows).toEqual([{ value: 4.1 }]);
    expect(await count('dead_letters')).toBe(1);
  });

  test('a late (out of order) message is stored, and delta checks use the sample time, not arrival order', async function () {
    await ingestMessage(makeMessage({ patient: 'P-55', value: 4.0, timestamp: '2026-03-04T10:00:00+05:30' }), { skipQc: true });
    const late = await ingestMessage(makeMessage({ patient: 'P-55', value: 6.0, timestamp: '2026-03-04T08:00:00+05:30' }), { skipQc: true });
    expect(late.status).toBe('stored');
    const third = await ingestMessage(makeMessage({ patient: 'P-55', value: 4.3, timestamp: '2026-03-04T12:00:00+05:30' }), { skipQc: true });
    expect(third.decision.outcome).toBe('RELEASED');
    expect(await count('results')).toBe(3);
  });

  test('stored results can not be updated or deleted (database refuses)', async function () {
    await ingestMessage(makeMessage(), { skipQc: true });
    await expect(db.query('UPDATE results SET value = 1')).rejects.toThrow(/append-only/);
    await expect(db.query('DELETE FROM results')).rejects.toThrow(/append-only/);
    await expect(db.query('DELETE FROM decisions')).rejects.toThrow(/append-only/);
  });
});

describe('dead letter store', function () {
  test('broken JSON is kept with the reason', async function () {
    const res = await request(app).post('/api/ingest').set(KEY).send('{"sample_id": "S-1", value: oops');
    expect(res.status).toBe(422);
    expect(res.body.status).toBe('dead_letter');
    const dl = await db.query('SELECT * FROM dead_letters');
    expect(dl.rows.length).toBe(1);
    expect(dl.rows[0].reason).toMatch(/invalid JSON/);
    expect(dl.rows[0].raw_message).toContain('oops');
  });

  test.each([
    ['missing value', function (m) { delete m.value; return m; }, /missing field: value/],
    ['value is text', function (m) { m.value = '4.1x'; return m; }, /value must be a number/],
    ['timestamp without timezone', function (m) { m.timestamp = '2026-03-04T09:15:22'; return m; }, /timezone/],
    ['unknown instrument', function (m) { m.instrument = 'INS-99'; return m; }, /unknown instrument/],
    ['negative hemolysis index', function (m) { m.h_index = -1; return m; }, /cannot be negative/],
    ['real name instead of pseudonym', function (m) { m.patient = 'Ramesh Kumar'; return m; }, /pseudonym/]
  ])('%s -> dead letter', async function (name, breakIt, expectedReason) {
    const outcome = await ingestMessage(breakIt(makeMessage()), { skipQc: true });
    expect(outcome.status).toBe('dead_letter');
    expect(outcome.reason).toMatch(expectedReason);
    expect(await count('dead_letters')).toBe(1);
    expect(await count('results')).toBe(0);
  });

  test('analyzers need the API key', async function () {
    const res = await request(app).post('/api/ingest').send(JSON.stringify(makeMessage()));
    expect(res.status).toBe(401);
  });
});

describe('delta check during ingestion', function () {
  test('a big jump from the previous result of the same patient is held', async function () {
    await ingestMessage(makeMessage({ patient: 'P-9', value: 4.0, timestamp: '2026-03-04T08:00:00+05:30' }), { skipQc: true });
    const second = await ingestMessage(makeMessage({ patient: 'P-9', value: 5.5, timestamp: '2026-03-05T08:00:00+05:30' }), { skipQc: true });
    expect(second.decision.outcome).toBe('HELD');
    expect(second.decision.triggered_rules.map(function (r) { return r.id; })).toContain('K-DELTA');
  });
});
