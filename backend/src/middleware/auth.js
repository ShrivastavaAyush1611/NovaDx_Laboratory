const db = require('../db');

async function requireLogin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.substring(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Not logged in (missing token)' });
  }
  const result = await db.query('SELECT id, username, role, lab_id FROM users WHERE token = $1', [token]);
  if (result.rows.length === 0) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  req.user = result.rows[0];
  next();
}

function requireRole() {
  const allowedRoles = Array.from(arguments);
  return function (req, res, next) {
    if (!req.user) {
      return res.status(401).json({ error: 'Not logged in' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Your role (' + req.user.role + ') is not allowed to do this' });
    }
    next();
  };
}

function requireAnalyzerKey(req, res, next) {
  const expected = process.env.INGEST_API_KEY || 'analyzer-key-123';
  if (req.headers['x-api-key'] !== expected) {
    return res.status(401).json({ error: 'Invalid or missing x-api-key' });
  }
  next();
}

module.exports = { requireLogin, requireRole, requireAnalyzerKey };
