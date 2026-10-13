
const { db, resetDatabase, makeMessage, count } = require('./helpers');
const { ingestMessage } = require('../src/services/ingestService');
const qcMonitor = require('../src/services/qcMonitor');
const alertService = require('../src/services/alertService');

beforeAll(async function () {
  await resetDatabase();
});

afterAll(async function () {
  await db.pool.end();
});

test('QC state after a restart is the same as before', async function () {
  const start = Date.parse('2026-03-04T00:30:00Z');
  for (let i = 0; i < 400; i++) {
    const t = new Date(start + i * 30000 + 5.5 * 3600000).toISOString().substring(0, 19) + '+05:30';
    const value = 4.0 + ((i * 37) % 11 - 5) * 0.06;
    await ingestMessage(makeMessage({ sample_id: 'S-R' + i, patient: 'P-R' + i, instrument: 'INS-01', value: Number(value.toFixed(2)), timestamp: t }));
  }
  const before = JSON.stringify(qcMonitor.getDetector());

  qcMonitor.reset();
  const replayed = await qcMonitor.init();
  const after = JSON.stringify(qcMonitor.getDetector());

  expect(replayed).toBe(400);
  expect(after).toEqual(before);
});

test('a notification saved before a crash is sent after the restart', async function () {
  await alertService.raiseAlert({ type: 'SHIFT', lab_id: 'LAB-1', instrument: 'INS-01', analyte: 'GLU', message: 'test', time: new Date().toISOString() });
  const sent = [];
  const summary = await alertService.processPendingNotifications({ channel: { name: 'test', send: async function (n) { sent.push(n.id); } } });
  expect(summary.sent).toBeGreaterThanOrEqual(1);
  expect(await count('notifications')).toBe(sent.length);
});
