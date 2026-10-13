const db = require('../db');
const { evaluate, validateRuleSetConfig } = require('./rulesEngine');

async function dryRun(config) {
  const errors = validateRuleSetConfig(config);
  if (errors.length > 0) {
    const err = new Error('Invalid rule set: ' + errors.join('; '));
    err.status = 400;
    throw err;
  }
  const proposed = { version: 'proposed', config: config };

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    const res = await client.query(
      `SELECT r.id, r.patient, r.analyte, r.value, r.unit, r.h_index, r.i_index, r.l_index,
              r.instrument_flags, r.collected_at, r.version, d.outcome AS stored_outcome,
              p.value AS previous_value, p.collected_at AS previous_collected_at
       FROM results r
       JOIN decisions d ON d.result_id = r.id AND d.seq = 1
       LEFT JOIN results p ON p.id = d.previous_result_id
       ORDER BY r.id`
    );
    await client.query('COMMIT');

    const report = {
      total_results: res.rows.length,
      would_change: 0,
      unchanged: 0,
      changes: {},           
      outcome_counts_now: { RELEASED: 0, HELD: 0, REJECTED: 0 },
      outcome_counts_proposed: { RELEASED: 0, HELD: 0, REJECTED: 0 },
      rules_triggered: {},   
      examples: []
    };

    for (const r of res.rows) {
      let previous = null;
      if (r.previous_value !== null) {
        previous = { value: r.previous_value, collected_at: r.previous_collected_at };
      }
      const decision = evaluate(r, previous, proposed);
      report.outcome_counts_now[r.stored_outcome]++;
      report.outcome_counts_proposed[decision.outcome]++;
      for (const t of decision.triggered_rules) {
        report.rules_triggered[t.id] = (report.rules_triggered[t.id] || 0) + 1;
      }
      if (decision.outcome !== r.stored_outcome) {
        report.would_change++;
        const change = r.stored_outcome + ' -> ' + decision.outcome;
        report.changes[change] = (report.changes[change] || 0) + 1;
        if (report.examples.length < 25) {
          report.examples.push({
            result_id: Number(r.id), analyte: r.analyte, value: r.value,
            stored: r.stored_outcome, proposed: decision.outcome, reason: decision.reason
          });
        }
      } else {
        report.unchanged++;
      }
    }
    return report;
  } catch (err) {
    await client.query('ROLLBACK').catch(function () {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { dryRun };
