
const db = require('../db');
const { sha256, stableStringify } = require('../utils');

const GENESIS_HASH = '0'.repeat(64);
const AUDIT_LOCK_ID = 777001; 

function computeHash(prevHash, entry) {
  const text = [
    prevHash,
    new Date(entry.created_at).toISOString(),
    entry.username,
    entry.role || '',
    entry.lab_id || '',
    entry.action,
    stableStringify(entry.details || {})
  ].join('|');
  return sha256(text);
}

async function addAuditEntry(user, action, details, client) {
  let ownClient = false;
  if (!client) {
    client = await db.pool.connect();
    ownClient = true;
    await client.query('BEGIN');
  }
  try {
    await client.query('SELECT pg_advisory_xact_lock($1)', [AUDIT_LOCK_ID]);
    const last = await client.query('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1');
    const prevHash = last.rows.length > 0 ? last.rows[0].hash : GENESIS_HASH;

    const entry = {
      created_at: new Date().toISOString(),
      username: user.username,
      role: user.role,
      lab_id: user.lab_id,
      action: action,
      details: details || {}
    };
    const hash = computeHash(prevHash, entry);
    await client.query(
      `INSERT INTO audit_log (created_at, username, role, lab_id, action, details, prev_hash, hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [entry.created_at, entry.username, entry.role, entry.lab_id, entry.action, JSON.stringify(entry.details), prevHash, hash]
    );
    if (ownClient) await client.query('COMMIT');
  } catch (err) {
    if (ownClient) await client.query('ROLLBACK');
    throw err;
  } finally {
    if (ownClient) client.release();
  }
}

async function verifyAuditLog() {
  const res = await db.query('SELECT * FROM audit_log ORDER BY id');
  let prevHash = GENESIS_HASH;
  for (const row of res.rows) {
    if (row.prev_hash !== prevHash) {
      return {
        valid: false,
        checked: res.rows.length,
        broken_at_id: Number(row.id),
        problem: 'prev_hash does not match the hash of the previous entry (an entry was changed, removed or inserted)'
      };
    }
    const expected = computeHash(prevHash, row);
    if (expected !== row.hash) {
      return {
        valid: false,
        checked: res.rows.length,
        broken_at_id: Number(row.id),
        problem: 'content of this entry was modified (hash does not match)'
      };
    }
    prevHash = row.hash;
  }
  return { valid: true, checked: res.rows.length, last_hash: prevHash };
}

module.exports = { addAuditEntry, verifyAuditLog, computeHash };
