const db = require('../db');
const { validateRuleSetConfig } = require('./rulesEngine');

let cache = { loadedAt: 0, ruleSets: [] };
const CACHE_MS = 5000;

async function loadAllRuleSets() {
  const res = await db.query('SELECT version, effective_from, description, config, created_by, created_at FROM rule_sets ORDER BY version');
  return res.rows;
}

function clearCache() {
  cache = { loadedAt: 0, ruleSets: [] };
}

async function getActiveRuleSet(when) {
  when = when || new Date();
  if (Date.now() - cache.loadedAt > CACHE_MS) {
    cache.ruleSets = await loadAllRuleSets();
    cache.loadedAt = Date.now();
  }
  let active = null;
  for (const rs of cache.ruleSets) {
    if (new Date(rs.effective_from) <= when) {
      if (!active || rs.version > active.version) active = rs;
    }
  }
  if (!active) {
    throw new Error('No active rule set found');
  }
  return active;
}

async function getRuleSet(version) {
  const res = await db.query('SELECT * FROM rule_sets WHERE version = $1', [version]);
  return res.rows[0] || null;
}

// saves a new version. old versions stay untouched.
async function createRuleSet(config, effectiveFrom, description, username) {
  const errors = validateRuleSetConfig(config);
  if (errors.length > 0) {
    const err = new Error('Invalid rule set: ' + errors.join('; '));
    err.status = 400;
    err.details = errors;
    throw err;
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE rule_sets IN EXCLUSIVE MODE');
    const res = await client.query('SELECT COALESCE(MAX(version), 0) + 1 AS next FROM rule_sets');
    const version = res.rows[0].next;
    const saved = await client.query(
      'INSERT INTO rule_sets (version, effective_from, description, config, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [version, effectiveFrom || new Date().toISOString(), description || '', JSON.stringify(config), username]
    );
    await client.query('COMMIT');
    clearCache();
    return saved.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { getActiveRuleSet, getRuleSet, createRuleSet, loadAllRuleSets, clearCache };
