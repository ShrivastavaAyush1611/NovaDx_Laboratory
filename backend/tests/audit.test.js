const request = require('supertest');
const { db, resetDatabase, auth } = require('./helpers');
const app = require('../src/app');
const { addAuditEntry, verifyAuditLog } = require('../src/services/audit');

const user = { username: 'super1', role: 'LabSupervisor', lab_id: 'LAB-1' };

beforeEach(async function () {
  await resetDatabase();
  for (let i = 1; i <= 5; i++) {
    await addAuditEntry(user, 'REVIEW_RELEASE', { result_id: i, comment: 'ok ' + i });
  }
});

afterAll(async function () {
  await db.pool.end();
});

async function tamper(sql) {
  await db.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_change');
  await db.query(sql);
  await db.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_change');
}

test('an untouched log is valid', async function () {
  const res = await request(app).get('/api/audit/verify').set(auth('auditor1'));
  expect(res.status).toBe(200);
  expect(res.body.valid).toBe(true);
  expect(res.body.checked).toBe(5);
});

test('normal UPDATE / DELETE on the audit log is refused by the database', async function () {
  await expect(db.query("UPDATE audit_log SET username = 'x'")).rejects.toThrow(/append-only/);
  await expect(db.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/);
});

test('a modified entry is detected', async function () {
  await tamper("UPDATE audit_log SET details = '{\"result_id\": 999, \"comment\": \"ok 3\"}' WHERE id = 3");
  const res = await request(app).get('/api/audit/verify').set(auth('auditor1'));
  expect(res.body.valid).toBe(false);
  expect(res.body.broken_at_id).toBe(3);
  expect(res.body.problem).toMatch(/modified/);
});

test('changing who did it is detected', async function () {
  await tamper("UPDATE audit_log SET username = 'someone_else' WHERE id = 2");
  const check = await verifyAuditLog();
  expect(check.valid).toBe(false);
  expect(check.broken_at_id).toBe(2);
});

test('a deleted entry is detected', async function () {
  await tamper('DELETE FROM audit_log WHERE id = 2');
  const check = await verifyAuditLog();
  expect(check.valid).toBe(false);
  expect(check.broken_at_id).toBe(3);
});

test('re-computing the hash of the changed entry is not enough (the next entry breaks)', async function () {
  const { computeHash } = require('../src/services/audit');
  const row = (await db.query('SELECT * FROM audit_log WHERE id = 2')).rows[0];
  row.details = '{"result_id": 2, "comment": "changed"}';
  const newHash = computeHash(row.prev_hash, row);
  await tamper("UPDATE audit_log SET details = '{\"result_id\": 2, \"comment\": \"changed\"}', hash = '" + newHash + "' WHERE id = 2");
  const check = await verifyAuditLog();
  expect(check.valid).toBe(false);
  expect(check.broken_at_id).toBe(3);
});

test('user actions are written to the audit log', async function () {
  await request(app).post('/api/auth/login').send({ username: 'tech1', password: 'password123' });
  const res = await request(app).get('/api/audit').set(auth('auditor1'));
  expect(res.body[0].action).toBe('LOGIN');
  expect(res.body[0].username).toBe('tech1');
});
