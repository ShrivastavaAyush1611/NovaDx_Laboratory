
const db = require('../db');
const { getChannel } = require('../channels');
const { getNumberSetting } = require('./settings');
const { addAuditEntry } = require('./audit');

function makeGroupKey(signal) {
  if (signal.type === 'DISAGREEMENT') {
    return 'DISAGREE|' + signal.lab_id + '|' + signal.analyte + '|' + signal.instrument + '|' + signal.other_instrument;
  }
  if (signal.type === 'LOT_SHIFT') {
    return 'LOT|' + signal.lab_id + '|' + signal.reagent_lot;
  }
  return 'QC|' + signal.lab_id + '|' + signal.instrument + '|' + signal.analyte;
}

const GROUP_HOURS = 24;

async function addNotification(client, alert, kind, recipient) {
  await client.query(
    'INSERT INTO notifications (alert_id, lab_id, kind, recipient) VALUES ($1, $2, $3, $4)',
    [alert.id, alert.lab_id, kind, recipient]
  );
}

async function raiseAlert(signal) {
  const groupKey = makeGroupKey(signal);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [groupKey]);
    const existing = await client.query(
      "SELECT * FROM alerts WHERE group_key = $1 AND last_seen > now() - ($2 || ' hours')::interval ORDER BY id DESC LIMIT 1",
      [groupKey, String(GROUP_HOURS)]
    );

    if (existing.rows.length > 0) {
      const updated = await client.query(
        'UPDATE alerts SET occurrences = occurrences + 1, last_seen = now() WHERE id = $1 RETURNING *',
        [existing.rows[0].id]
      );
      await client.query('COMMIT');
      return { alert: updated.rows[0], created: false };
    }

    const inserted = await client.query(
      `INSERT INTO alerts (lab_id, type, group_key, instrument, analyte, reagent_lot, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [signal.lab_id, signal.type, groupKey, signal.instrument || null, signal.analyte || null, signal.reagent_lot || null, signal.message]
    );
    const alert = inserted.rows[0];
    await addNotification(client, alert, 'NEW', 'LabTechnician');
    await client.query('COMMIT');
    return { alert: alert, created: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(function () {});
    throw err;
  } finally {
    client.release();
  }
}

async function acknowledgeAlert(id, user) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query(
      `UPDATE alerts SET state = 'ACKNOWLEDGED', acknowledged_by = $3, acknowledged_at = now()
       WHERE id = $1 AND lab_id = $2 AND state IN ('OPEN', 'ESCALATED') RETURNING *`,
      [id, user.lab_id, user.username]
    );
    if (res.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    await addAuditEntry(user, 'ALERT_ACKNOWLEDGED', { alert_id: Number(id) }, client);
    await client.query('COMMIT');
    return res.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function checkEscalations() {
  const minutes = await getNumberSetting('escalation_minutes', 15);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query(
      `UPDATE alerts SET state = 'ESCALATED', escalated_at = now()
       WHERE state = 'OPEN' AND first_seen <= now() - ($1 || ' minutes')::interval
       RETURNING *`,
      [String(minutes)]
    );
    for (const alert of res.rows) {
      await addNotification(client, alert, 'ESCALATION', 'LabSupervisor');
    }
    await client.query('COMMIT');
    return res.rows;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function retryDelaySeconds(attempts) {
  return Math.min(300, Math.pow(2, attempts));
}

async function processPendingNotifications(options) {
  options = options || {};
  const channel = options.channel || getChannel();
  const maxAttempts = await getNumberSetting('max_send_attempts', 8);
  const maxPerHour = await getNumberSetting('max_notifications_per_hour', 20);
  const summary = { sent: 0, failed: 0, retry_later: 0, rate_limited: 0 };

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    // SKIP LOCKED: if two workers run, they don't take the same rows
    const pending = await client.query(
      `SELECT n.*, a.type, a.message, a.state, a.occurrences
       FROM notifications n JOIN alerts a ON a.id = n.alert_id
       WHERE n.status = 'PENDING' AND n.next_attempt_at <= now()
       ORDER BY n.id
       LIMIT 50
       FOR UPDATE OF n SKIP LOCKED`
    );

    for (const n of pending.rows) {
      // rate limit per lab (escalations are never held back, they are too important)
      if (n.kind !== 'ESCALATION') {
        const sentLastHour = await client.query(
          "SELECT COUNT(*)::int AS c FROM notifications WHERE lab_id = $1 AND status = 'SENT' AND sent_at > now() - interval '1 hour'",
          [n.lab_id]
        );
        if (sentLastHour.rows[0].c >= maxPerHour) {
          await client.query("UPDATE notifications SET next_attempt_at = now() + interval '5 minutes' WHERE id = $1", [n.id]);
          summary.rate_limited++;
          continue;
        }
      }

      const alert = { id: n.alert_id, type: n.type, message: n.message, state: n.state, occurrences: n.occurrences };
      try {
        await channel.send(n, alert);
        await client.query(
          "UPDATE notifications SET status = 'SENT', attempts = attempts + 1, sent_at = now(), channel = $2, last_error = NULL WHERE id = $1",
          [n.id, channel.name]
        );
        summary.sent++;
      } catch (err) {
        const attempts = n.attempts + 1;
        if (attempts >= maxAttempts) {
          await client.query(
            "UPDATE notifications SET status = 'FAILED', attempts = $2, last_error = $3, channel = $4 WHERE id = $1",
            [n.id, attempts, err.message, channel.name]
          );
          summary.failed++;
        } else {
          await client.query(
            "UPDATE notifications SET attempts = $2, last_error = $3, channel = $4, next_attempt_at = now() + ($5 || ' seconds')::interval WHERE id = $1",
            [n.id, attempts, err.message, channel.name, String(retryDelaySeconds(attempts))]
          );
          summary.retry_later++;
        }
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return summary;
}

module.exports = {
  raiseAlert, acknowledgeAlert, checkEscalations, processPendingNotifications,
  makeGroupKey, retryDelaySeconds
};
