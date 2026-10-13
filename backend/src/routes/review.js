const express = require('express');
const db = require('../db');
const { requireRole } = require('../middleware/auth');
const { addAuditEntry } = require('../services/audit');

const router = express.Router();

router.get('/queue', requireRole('LabSupervisor'), async function (req, res) {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const result = await db.query(
    `SELECT r.id, r.sample_id, r.patient, r.analyte, r.value, r.unit, r.instrument, r.reagent_lot,
            r.h_index, r.i_index, r.l_index, r.collected_at, r.version,
            d.reason, d.triggered_rules, d.rule_set_version, d.decided_at
     FROM results r
     JOIN LATERAL (SELECT * FROM decisions dd WHERE dd.result_id = r.id ORDER BY dd.seq DESC LIMIT 1) d ON true
     WHERE r.lab_id = $1 AND d.outcome = 'HELD'
       AND NOT EXISTS (SELECT 1 FROM results newer WHERE newer.sample_id = r.sample_id
                       AND newer.analyte = r.analyte AND newer.version > r.version)
     ORDER BY r.collected_at
     LIMIT $2`,
    [req.user.lab_id, limit]
  );
  const count = await db.query(
    `SELECT COUNT(*)::int AS count FROM results r JOIN current_decisions d ON d.result_id = r.id
     WHERE r.lab_id = $1 AND d.outcome = 'HELD'`,
    [req.user.lab_id]
  );
  res.json({ total_held: count.rows[0].count, items: result.rows });
});

router.post('/:id', requireRole('LabSupervisor'), async function (req, res) {
  const action = req.body.action;
  const comment = req.body.comment || '';
  if (action !== 'RELEASE' && action !== 'REJECT') {
    return res.status(400).json({ error: 'action must be RELEASE or REJECT' });
  }
  if (!/^\d+$/.test(req.params.id)) {
    return res.status(404).json({ error: 'Result not found' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query('SELECT id FROM results WHERE id = $1 AND lab_id = $2', [req.params.id, req.user.lab_id]);
    if (found.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Result not found' });
    }
    const current = await client.query(
      'SELECT * FROM decisions WHERE result_id = $1 ORDER BY seq DESC LIMIT 1 FOR UPDATE',
      [req.params.id]
    );
    const last = current.rows[0];
    if (last.outcome !== 'HELD') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Result is not on hold (current outcome: ' + last.outcome + ')' });
    }
    const outcome = action === 'RELEASE' ? 'RELEASED' : 'REJECTED';
    const inserted = await client.query(
      `INSERT INTO decisions (result_id, seq, outcome, rule_set_version, triggered_rules, reason, decided_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.params.id, last.seq + 1, outcome, last.rule_set_version, JSON.stringify(last.triggered_rules),
        'Manual review: ' + (comment || action.toLowerCase()), req.user.username]
    );
    await addAuditEntry(req.user, 'REVIEW_' + action, { result_id: Number(req.params.id), comment: comment }, client);
    await client.query('COMMIT');
    res.json(inserted.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

module.exports = router;
