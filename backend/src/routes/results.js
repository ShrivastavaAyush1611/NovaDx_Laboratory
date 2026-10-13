const express = require('express');
const db = require('../db');
const { requireRole } = require('../middleware/auth');
const { evaluate } = require('../services/rulesEngine');
const { getRuleSet, getActiveRuleSet } = require('../services/ruleSets');
const { findPreviousResult } = require('../services/ingestService');
const { addAuditEntry } = require('../services/audit');
const { sha256, stableStringify } = require('../utils');

const router = express.Router();

const ALL_ROLES = ['LabTechnician', 'QualityEngineer', 'LabSupervisor', 'Auditor'];

async function getResultForUser(id, user) {
  if (!/^\d+$/.test(String(id))) return null;
  const res = await db.query('SELECT * FROM results WHERE id = $1 AND lab_id = $2', [id, user.lab_id]);
  return res.rows[0] || null;
}

router.get('/', requireRole(...ALL_ROLES), async function (req, res) {
  const params = [req.user.lab_id];
  let where = 'r.lab_id = $1';

  if (req.query.analyte) {
    params.push(req.query.analyte);
    where += ' AND r.analyte = $' + params.length;
  }
  if (req.query.instrument) {
    params.push(req.query.instrument);
    where += ' AND r.instrument = $' + params.length;
  }
  if (req.query.search) {
    params.push(req.query.search + '%');
    where += ' AND (r.sample_id LIKE $' + params.length + ' OR r.patient LIKE $' + params.length + ')';
  }
  if (req.query.outcome) {
    params.push(req.query.outcome);
    where += ' AND d.outcome = $' + params.length;
  }
  if (req.query.flagged === 'true') {
    where += ' AND EXISTS (SELECT 1 FROM result_flags f WHERE f.result_id = r.id)';
  }

  let limit = parseInt(req.query.limit, 10) || 50;
  if (limit > 500) limit = 500;
  const offset = parseInt(req.query.offset, 10) || 0;
  params.push(limit);
  params.push(offset);

  const sql = `
    SELECT r.id, r.sample_id, r.patient, r.analyte, r.value, r.unit, r.instrument, r.reagent_lot,
           r.h_index, r.i_index, r.l_index, r.collected_at, r.original_timestamp, r.received_at, r.version,
           r.corrects_result_id,
           d.outcome, d.reason, d.triggered_rules, d.rule_set_version, d.decided_by, d.decided_at,
           (SELECT COUNT(*) FROM result_flags f WHERE f.result_id = r.id)::int AS flag_count
    FROM results r
    JOIN LATERAL (
      SELECT * FROM decisions dd WHERE dd.result_id = r.id ORDER BY dd.seq DESC LIMIT 1
    ) d ON true
    WHERE ${where}
      AND NOT EXISTS (
        SELECT 1 FROM results newer
        WHERE newer.sample_id = r.sample_id AND newer.analyte = r.analyte AND newer.version > r.version
      )
    ORDER BY r.id DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}`;

  const result = await db.query(sql, params);
  res.json(result.rows);
});

router.get('/summary', requireRole(...ALL_ROLES), async function (req, res) {
  const result = await db.query(
    `SELECT d.outcome, COUNT(*)::int AS count
     FROM results r JOIN current_decisions d ON d.result_id = r.id
     WHERE r.lab_id = $1
     GROUP BY d.outcome`,
    [req.user.lab_id]
  );
  const dup = await db.query(
    'SELECT COUNT(*)::int AS count FROM duplicate_messages dm JOIN results r ON r.id = dm.result_id WHERE r.lab_id = $1',
    [req.user.lab_id]
  );
  const dead = await db.query('SELECT COUNT(*)::int AS count FROM dead_letters WHERE lab_id = $1', [req.user.lab_id]);
  const summary = { RELEASED: 0, HELD: 0, REJECTED: 0, duplicates_received: dup.rows[0].count, dead_letters: dead.rows[0].count };
  for (const row of result.rows) summary[row.outcome] = row.count;
  res.json(summary);
});

router.get('/:id', requireRole(...ALL_ROLES), async function (req, res) {
  const result = await getResultForUser(req.params.id, req.user);
  if (!result) {
    return res.status(404).json({ error: 'Result not found' });
  }
  const decisions = await db.query('SELECT * FROM decisions WHERE result_id = $1 ORDER BY seq', [result.id]);
  const versions = await db.query(
    'SELECT id, version, value, unit, created_by, correction_reason, received_at FROM results WHERE sample_id = $1 AND analyte = $2 AND lab_id = $3 ORDER BY version',
    [result.sample_id, result.analyte, req.user.lab_id]
  );
  const flags = await db.query(
    `SELECT f.*, c.kind, c.target, c.start_time, c.description
     FROM result_flags f JOIN impact_cases c ON c.id = f.impact_case_id
     WHERE f.result_id = $1`,
    [result.id]
  );
  const latestVersion = versions.rows[versions.rows.length - 1];
  res.json({
    result: result,
    is_current: latestVersion && Number(latestVersion.id) === Number(result.id),
    decisions: decisions.rows,
    versions: versions.rows,
    flags: flags.rows
  });
});

router.get('/:id/reproduce', requireRole(...ALL_ROLES), async function (req, res) {
  const result = await getResultForUser(req.params.id, req.user);
  if (!result) {
    return res.status(404).json({ error: 'Result not found' });
  }
  const autoDecision = await db.query(
    "SELECT * FROM decisions WHERE result_id = $1 AND decided_by = 'AUTO' ORDER BY seq LIMIT 1",
    [result.id]
  );
  const original = autoDecision.rows[0];
  const ruleSet = await getRuleSet(original.rule_set_version);
  const client = await db.pool.connect();
  let previous;
  try {
    previous = await findPreviousResult(client, result.patient, result.analyte, result.collected_at, result.id);
  } finally {
    client.release();
  }
  const again = evaluate(result, previous, ruleSet);
  res.json({
    result_id: Number(result.id),
    rule_set_version: original.rule_set_version,
    original_outcome: original.outcome,
    reproduced_outcome: again.outcome,
    original_reason: original.reason,
    reproduced_reason: again.reason,
    same: original.outcome === again.outcome && original.reason === again.reason
  });
});


router.post('/:id/correct', requireRole('LabSupervisor'), async function (req, res) {
  const original = await getResultForUser(req.params.id, req.user);
  if (!original) {
    return res.status(404).json({ error: 'Result not found' });
  }
  const newValue = Number(req.body.value);
  const reason = req.body.reason;
  if (req.body.value === undefined || req.body.value === '' || !Number.isFinite(newValue)) {
    return res.status(400).json({ error: 'value must be a number' });
  }
  if (!reason) {
    return res.status(400).json({ error: 'reason is required for a correction' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const latest = await client.query(
      'SELECT * FROM results WHERE sample_id = $1 AND analyte = $2 ORDER BY version DESC LIMIT 1 FOR UPDATE',
      [original.sample_id, original.analyte]
    );
    const base = latest.rows[0];
    const newVersion = base.version + 1;
    const hash = sha256(stableStringify({ corrects: base.id, value: newValue, reason: reason, by: req.user.username }));

    const inserted = await client.query(
      `INSERT INTO results (sample_id, patient, analyte, value, unit, instrument, lab_id, reagent_lot,
          h_index, i_index, l_index, instrument_flags, collected_at, original_timestamp, message_hash,
          version, corrects_result_id, correction_reason, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING *`,
      [base.sample_id, base.patient, base.analyte, newValue, base.unit, base.instrument, base.lab_id, base.reagent_lot,
        base.h_index, base.i_index, base.l_index, JSON.stringify(base.instrument_flags), base.collected_at,
        base.original_timestamp, hash, newVersion, base.id, reason, req.user.username]
    );
    const corrected = inserted.rows[0];

    const ruleSet = await getActiveRuleSet(new Date());
    const previous = await findPreviousResult(client, corrected.patient, corrected.analyte, corrected.collected_at, corrected.id);
    const decision = evaluate(corrected, previous, ruleSet);
    await client.query(
      `INSERT INTO decisions (result_id, seq, outcome, rule_set_version, triggered_rules, reason, decided_by)
       VALUES ($1, 1, $2, $3, $4, $5, 'AUTO')`,
      [corrected.id, decision.outcome, decision.rule_set_version, JSON.stringify(decision.triggered_rules), decision.reason]
    );

    await addAuditEntry(req.user, 'RESULT_CORRECTED', {
      original_result_id: Number(base.id),
      corrected_result_id: Number(corrected.id),
      old_value: base.value,
      new_value: newValue,
      reason: reason
    }, client);

    await client.query('COMMIT');
    res.status(201).json({ corrected: corrected, decision: decision });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

module.exports = router;
