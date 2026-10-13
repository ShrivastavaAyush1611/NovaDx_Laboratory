const db = require('../db');
const { validateMessage } = require('./validate');
const { evaluate } = require('./rulesEngine');
const { getActiveRuleSet } = require('./ruleSets');
const { sha256, stableStringify } = require('../utils');

let instrumentCache = null;

async function getInstrumentLab(instrumentId) {
  if (!instrumentCache) {
    const res = await db.query('SELECT id, lab_id FROM instruments');
    instrumentCache = {};
    for (const row of res.rows) instrumentCache[row.id] = row.lab_id;
  }
  return instrumentCache[instrumentId] || null;
}

function clearInstrumentCache() {
  instrumentCache = null;
}

async function saveDeadLetter(rawMessage, reason, labId) {
  let rawText = rawMessage;
  if (typeof rawMessage !== 'string') {
    rawText = JSON.stringify(rawMessage);
  }
  if (rawText === undefined) rawText = 'undefined';
  const res = await db.query(
    'INSERT INTO dead_letters (raw_message, reason, lab_id) VALUES ($1, $2, $3) RETURNING id',
    [rawText, reason, labId || null]
  );
  return res.rows[0].id;
}


async function findPreviousResult(client, patient, analyte, collectedAt, newId) {
  const res = await client.query(
    `SELECT id, value, collected_at FROM results
     WHERE patient = $1 AND analyte = $2 AND collected_at < $3 AND id < $4
     ORDER BY collected_at DESC, version DESC
     LIMIT 1`,
    [patient, analyte, collectedAt, newId]
  );
  return res.rows[0] || null;
}

async function ingestMessage(message, options) {
  options = options || {};

  const errors = validateMessage(message);
  if (errors.length > 0) {
    let labId = null;
    if (message && typeof message.instrument === 'string') {
      labId = await getInstrumentLab(message.instrument);
    }
    const id = await saveDeadLetter(message, errors.join('; '), labId);
    return { status: 'dead_letter', dead_letter_id: id, reason: errors.join('; ') };
  }

  const labId = await getInstrumentLab(message.instrument);
  if (!labId) {
    const reason = 'unknown instrument: ' + message.instrument;
    const id = await saveDeadLetter(message, reason, null);
    return { status: 'dead_letter', dead_letter_id: id, reason: reason };
  }

  const messageHash = sha256(stableStringify(message));
  const collectedAt = new Date(message.timestamp).toISOString();
  const flags = message.instrument_flags || [];

  const client = await db.pool.connect();
  let stored = null;
  let decision = null;
  try {
    await client.query('BEGIN');


    const insert = await client.query(
      `INSERT INTO results (sample_id, patient, analyte, value, unit, instrument, lab_id, reagent_lot,
          h_index, i_index, l_index, instrument_flags, collected_at, original_timestamp, message_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (sample_id, analyte, version) DO NOTHING
       RETURNING *`,
      [message.sample_id, message.patient, message.analyte, message.value, message.unit, message.instrument, labId,
        message.reagent_lot, message.h_index, message.i_index, message.l_index, JSON.stringify(flags),
        collectedAt, message.timestamp, messageHash]
    );

    if (insert.rows.length === 0) {
      const existing = await client.query(
        'SELECT id, message_hash FROM results WHERE sample_id = $1 AND analyte = $2 AND version = 1',
        [message.sample_id, message.analyte]
      );
      const existingRow = existing.rows[0];
      if (existingRow.message_hash === messageHash) {
        await client.query('INSERT INTO duplicate_messages (result_id) VALUES ($1)', [existingRow.id]);
        await client.query('COMMIT');
        return { status: 'duplicate', result_id: existingRow.id };
      }

      await client.query('ROLLBACK');
      const reason = 'conflicting duplicate: sample ' + message.sample_id + ' / ' + message.analyte +
        ' already stored (result id ' + existingRow.id + ') with different content';
      const id = await saveDeadLetter(message, reason, labId);
      return { status: 'dead_letter', dead_letter_id: id, reason: reason, result_id: existingRow.id };
    }

    stored = insert.rows[0];

    const ruleSet = await getActiveRuleSet(new Date());
    const previous = await findPreviousResult(client, stored.patient, stored.analyte, stored.collected_at, stored.id);
    decision = evaluate(stored, previous, ruleSet);

    await client.query(
      `INSERT INTO decisions (result_id, seq, outcome, rule_set_version, triggered_rules, reason, decided_by)
       VALUES ($1, 1, $2, $3, $4, $5, 'AUTO')`,
      [stored.id, decision.outcome, decision.rule_set_version, JSON.stringify(decision.triggered_rules), decision.reason]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(function () {});
    throw err;
  } finally {
    client.release();
  }

  if (!options.skipQc) {
    try {
      const qcMonitor = require('./qcMonitor');
      await qcMonitor.processResult(stored);
    } catch (err) {
      console.log('QC monitoring error for result ' + stored.id + ': ' + err.message);
    }
  }

  return { status: 'stored', result_id: stored.id, decision: decision };
}

module.exports = { ingestMessage, saveDeadLetter, findPreviousResult, clearInstrumentCache };
