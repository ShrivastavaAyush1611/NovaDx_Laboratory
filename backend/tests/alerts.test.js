const request = require('supertest');
const { db, resetDatabase, auth, count } = require('./helpers');
const app = require('../src/app');
const alertService = require('../src/services/alertService');
const { setSetting } = require('../src/services/settings');

function signal(overrides) {
  return Object.assign({
    type: 'SHIFT', lab_id: 'LAB-1', instrument: 'INS-01', analyte: 'K', reagent_lot: 'LOT-1',
    message: 'K on INS-01: moving average shifted', score: 0.8, time: new Date().toISOString(), result_id: 1
  }, overrides || {});
}

function flakyChannel(failTimes) {
  const ch = {
    name: 'flaky',
    calls: 0,
    sent: [],
    send: async function (notification) {
      ch.calls++;
      if (ch.calls <= failTimes) throw new Error('network down');
      ch.sent.push(Number(notification.id));
    }
  };
  return ch;
}

async function makeDueNow() {
  await db.query("UPDATE notifications SET next_attempt_at = now() WHERE status = 'PENDING'");
}

beforeEach(async function () {
  await resetDatabase();
});

afterAll(async function () {
  await db.pool.end();
});

test('alert and its notification are saved in the database BEFORE anything is sent', async function () {
  const { alert, created } = await alertService.raiseAlert(signal());
  expect(created).toBe(true);
  const saved = await db.query('SELECT * FROM alerts WHERE id = $1', [alert.id]);
  expect(saved.rows[0].state).toBe('OPEN');
  const n = await db.query('SELECT * FROM notifications WHERE alert_id = $1', [alert.id]);
  expect(n.rows.length).toBe(1);
  expect(n.rows[0].status).toBe('PENDING'); 
});

test('a failed notification is retried until it succeeds', async function () {
  await alertService.raiseAlert(signal());
  const channel = flakyChannel(2);

  let summary = await alertService.processPendingNotifications({ channel: channel });
  expect(summary.retry_later).toBe(1);
  let n = (await db.query('SELECT * FROM notifications')).rows[0];
  expect(n.status).toBe('PENDING');
  expect(n.attempts).toBe(1);
  expect(n.last_error).toBe('network down');
  expect(new Date(n.next_attempt_at).getTime()).toBeGreaterThan(Date.now()); 

  summary = await alertService.processPendingNotifications({ channel: channel });
  expect(summary).toEqual({ sent: 0, failed: 0, retry_later: 0, rate_limited: 0 });

  await makeDueNow();
  await alertService.processPendingNotifications({ channel: channel });
  await makeDueNow();
  summary = await alertService.processPendingNotifications({ channel: channel });
  expect(summary.sent).toBe(1);
  n = (await db.query('SELECT * FROM notifications')).rows[0];
  expect(n.status).toBe('SENT');
  expect(n.attempts).toBe(3);
  expect(channel.sent).toEqual([Number(n.id)]);
});

test('after too many failures the notification is FAILED but the alert is still there (and will escalate)', async function () {
  await setSetting('max_send_attempts', 3);
  await alertService.raiseAlert(signal());
  const channel = flakyChannel(100);
  for (let i = 0; i < 3; i++) {
    await makeDueNow();
    await alertService.processPendingNotifications({ channel: channel });
  }
  const n = (await db.query('SELECT * FROM notifications')).rows[0];
  expect(n.status).toBe('FAILED');
  expect(n.attempts).toBe(3);
  expect(await count('alerts')).toBe(1);
});

test('retry wait time grows (2, 4, 8 ... seconds, max 5 minutes)', function () {
  expect(alertService.retryDelaySeconds(1)).toBe(2);
  expect(alertService.retryDelaySeconds(2)).toBe(4);
  expect(alertService.retryDelaySeconds(3)).toBe(8);
  expect(alertService.retryDelaySeconds(20)).toBe(300);
});

test('unacknowledged alert escalates after the configured time and the supervisor is notified', async function () {
  await setSetting('escalation_minutes', 15);
  const { alert } = await alertService.raiseAlert(signal());

  await db.query("UPDATE alerts SET first_seen = now() - interval '10 minutes' WHERE id = $1", [alert.id]);
  expect((await alertService.checkEscalations()).length).toBe(0);

  await db.query("UPDATE alerts SET first_seen = now() - interval '16 minutes' WHERE id = $1", [alert.id]);
  const escalated = await alertService.checkEscalations();
  expect(escalated.length).toBe(1);
  const a = (await db.query('SELECT * FROM alerts WHERE id = $1', [alert.id])).rows[0];
  expect(a.state).toBe('ESCALATED');
  const n = await db.query("SELECT * FROM notifications WHERE kind = 'ESCALATION'");
  expect(n.rows.length).toBe(1);
  expect(n.rows[0].recipient).toBe('LabSupervisor');

  expect((await alertService.checkEscalations()).length).toBe(0);
});

test('escalation time is configurable', async function () {
  await setSetting('escalation_minutes', 60);
  const { alert } = await alertService.raiseAlert(signal());
  await db.query("UPDATE alerts SET first_seen = now() - interval '30 minutes' WHERE id = $1", [alert.id]);
  expect((await alertService.checkEscalations()).length).toBe(0);
  await setSetting('escalation_minutes', 20);
  expect((await alertService.checkEscalations()).length).toBe(1);
});

test('an acknowledged alert does not escalate', async function () {
  const { alert } = await alertService.raiseAlert(signal());
  const res = await request(app).post('/api/alerts/' + alert.id + '/acknowledge').set(auth('tech1'));
  expect(res.status).toBe(200);
  expect(res.body.state).toBe('ACKNOWLEDGED');
  await db.query("UPDATE alerts SET first_seen = now() - interval '2 hours' WHERE id = $1", [alert.id]);
  expect((await alertService.checkEscalations()).length).toBe(0);
});

test('the same problem 100 times gives ONE alert and ONE notification', async function () {
  for (let i = 0; i < 100; i++) {
    await alertService.raiseAlert(signal({ type: i % 2 ? 'SHIFT' : 'DRIFT' }));
  }
  expect(await count('alerts')).toBe(1);
  expect(await count('notifications')).toBe(1);
  const a = (await db.query('SELECT * FROM alerts')).rows[0];
  expect(a.occurrences).toBe(100);
});

test('grouping also works when the same alert is raised in parallel', async function () {
  await Promise.all(Array.from({ length: 10 }, function () { return alertService.raiseAlert(signal()); }));
  expect(await count('alerts')).toBe(1);
  expect((await db.query('SELECT occurrences FROM alerts')).rows[0].occurrences).toBe(10);
});

test('the same problem after more than 24 hours opens a new alert', async function () {
  const { alert } = await alertService.raiseAlert(signal());
  await db.query("UPDATE alerts SET last_seen = now() - interval '25 hours' WHERE id = $1", [alert.id]);
  const again = await alertService.raiseAlert(signal());
  expect(again.created).toBe(true);
  expect(await count('alerts')).toBe(2);
});

test('notifications per lab are rate limited (but nothing is dropped)', async function () {
  await setSetting('max_notifications_per_hour', 2);
  for (const ins of ['INS-01', 'INS-02']) {
    for (const analyte of ['K', 'GLU']) {
      await alertService.raiseAlert(signal({ instrument: ins, analyte: analyte }));
    }
  }
  const channel = flakyChannel(0);
  const summary = await alertService.processPendingNotifications({ channel: channel });
  expect(summary.sent).toBe(2);
  expect(summary.rate_limited).toBe(2);
  const pending = await db.query("SELECT COUNT(*)::int AS c FROM notifications WHERE status = 'PENDING'");
  expect(pending.rows[0].c).toBe(2);
});

test('escalation notifications are never held back by the rate limit', async function () {
  await setSetting('max_notifications_per_hour', 0);
  const { alert } = await alertService.raiseAlert(signal());
  await db.query("UPDATE alerts SET first_seen = now() - interval '1 hour' WHERE id = $1", [alert.id]);
  await alertService.checkEscalations();
  const summary = await alertService.processPendingNotifications({ channel: flakyChannel(0) });
  expect(summary.sent).toBe(1);
  expect(summary.rate_limited).toBe(1);
});

test('an Auditor can see alerts but can not acknowledge them', async function () {
  const { alert } = await alertService.raiseAlert(signal());
  expect((await request(app).get('/api/alerts').set(auth('auditor1'))).body.length).toBe(1);
  expect((await request(app).post('/api/alerts/' + alert.id + '/acknowledge').set(auth('auditor1'))).status).toBe(403);
});
