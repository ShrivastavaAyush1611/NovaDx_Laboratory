const db = require('../db');
const { addAuditEntry } = require('./audit');

async function createImpactCase(input, user) {
  if (input.kind !== 'instrument' && input.kind !== 'reagent_lot') {
    const err = new Error('kind must be instrument or reagent_lot');
    err.status = 400;
    throw err;
  }
  if (!input.target || !input.start_time || isNaN(new Date(input.start_time).getTime())) {
    const err = new Error('target and a valid start_time are required');
    err.status = 400;
    throw err;
  }

  if (input.kind === 'instrument') {
    const ins = await db.query('SELECT lab_id FROM instruments WHERE id = $1', [input.target]);
    if (ins.rows.length === 0 || ins.rows[0].lab_id !== user.lab_id) {
      const err = new Error('Instrument not found in your laboratory');
      err.status = 404;
      throw err;
    }
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const created = await client.query(
      `INSERT INTO impact_cases (kind, target, start_time, description, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [input.kind, input.target, input.start_time, input.description || '', user.username]
    );
    const impactCase = created.rows[0];

    const column = impactCase.kind === 'instrument' ? 'instrument' : 'reagent_lot';
    const flagged = await client.query(
      `INSERT INTO result_flags (result_id, impact_case_id, flag)
       SELECT r.id, $1, 'POTENTIALLY_AFFECTED'
       FROM results r
       JOIN current_decisions d ON d.result_id = r.id
       WHERE r.` + column + ` = $2
         AND r.collected_at >= $3
         AND r.version = 1
         AND d.outcome = 'RELEASED'
       RETURNING result_id`,
      [impactCase.id, impactCase.target, impactCase.start_time]
    );

    await addAuditEntry(user, 'IMPACT_CASE_CREATED', {
      impact_case_id: Number(impactCase.id), kind: impactCase.kind, target: impactCase.target,
      start_time: impactCase.start_time, flagged_results: flagged.rows.length
    }, client);
    await client.query('COMMIT');
    return { impact_case: impactCase, flagged_total: flagged.rows.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function listImpactCases(labId) {
  const res = await db.query(
    `SELECT c.*,
       (SELECT COUNT(*)::int FROM result_flags f JOIN results r ON r.id = f.result_id
        WHERE f.impact_case_id = c.id AND r.lab_id = $1) AS affected_in_my_lab
     FROM impact_cases c
     WHERE c.kind = 'reagent_lot' OR c.target IN (SELECT id FROM instruments WHERE lab_id = $1)
     ORDER BY c.id DESC`,
    [labId]
  );
  return res.rows;
}

async function getImpactReport(caseId, labId) {
  if (!/^\d+$/.test(String(caseId))) return null;
  const caseRes = await db.query('SELECT * FROM impact_cases WHERE id = $1', [caseId]);
  const impactCase = caseRes.rows[0];
  if (!impactCase) return null;
  if (impactCase.kind === 'instrument') {
    const ins = await db.query('SELECT lab_id FROM instruments WHERE id = $1', [impactCase.target]);
    if (ins.rows[0].lab_id !== labId) return null;
  }
  const lab = await db.query('SELECT * FROM labs WHERE id = $1', [labId]);

  const rows = await db.query(
    `SELECT r.id AS result_id, r.sample_id, r.patient, r.analyte, r.value, r.unit, r.instrument, r.reagent_lot,
            r.collected_at, d.decided_at AS released_at, d.decided_by AS released_by, f.flag, f.created_at AS flagged_at,
            corr.id AS corrected_result_id, corr.value AS corrected_value, corr.created_by AS corrected_by
     FROM result_flags f
     JOIN results r ON r.id = f.result_id
     JOIN LATERAL (SELECT * FROM decisions dd WHERE dd.result_id = r.id ORDER BY dd.seq DESC LIMIT 1) d ON true
     LEFT JOIN LATERAL (
       SELECT * FROM results c WHERE c.sample_id = r.sample_id AND c.analyte = r.analyte AND c.version > r.version
       ORDER BY c.version DESC LIMIT 1
     ) corr ON true
     WHERE f.impact_case_id = $1 AND r.lab_id = $2
     ORDER BY r.collected_at`,
    [caseId, labId]
  );

  const patients = {};
  let corrected = 0;
  for (const row of rows.rows) {
    patients[row.patient] = true;
    if (row.corrected_result_id) corrected++;
  }
  return {
    impact_case: impactCase,
    lab: lab.rows[0],
    summary: {
      affected_results: rows.rows.length,
      affected_patients: Object.keys(patients).length,
      corrected: corrected,
      still_to_review: rows.rows.length - corrected
    },
    results: rows.rows
  };
}

module.exports = { createImpactCase, listImpactCases, getImpactReport };
