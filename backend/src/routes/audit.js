const express = require('express');
const db = require('../db');
const { requireRole } = require('../middleware/auth');
const { verifyAuditLog, addAuditEntry } = require('../services/audit');

const router = express.Router();

router.use(requireRole('Auditor'));

router.get('/', async function (req, res) {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
  const result = await db.query('SELECT * FROM audit_log WHERE lab_id = $1 ORDER BY id DESC LIMIT $2', [req.user.lab_id, limit]);
  res.json(result.rows);
});

router.get('/verify', async function (req, res) {
  const check = await verifyAuditLog();
  await addAuditEntry(req.user, 'AUDIT_LOG_VERIFIED', { valid: check.valid, checked: check.checked, broken_at_id: check.broken_at_id || null });
  res.json(check);
});

module.exports = router;