const db = require('../db');

async function getSetting(key, defaultValue) {
  const res = await db.query('SELECT value FROM settings WHERE key = $1', [key]);
  if (res.rows.length === 0) return defaultValue;
  return res.rows[0].value;
}

async function getNumberSetting(key, defaultValue) {
  const value = Number(await getSetting(key, defaultValue));
  if (!Number.isFinite(value)) return defaultValue;
  return value;
}

async function setSetting(key, value) {
  await db.query(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
    [key, String(value)]
  );
}

async function getAllSettings() {
  const res = await db.query('SELECT key, value FROM settings ORDER BY key');
  const out = {};
  for (const row of res.rows) out[row.key] = row.value;
  return out;
}

module.exports = { getSetting, getNumberSetting, setSetting, getAllSettings };
