const express = require('express');
const db = require('../db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireRole('LabTechnician', 'QualityEngineer', 'LabSupervisor', 'Auditor'), async function (req, res) {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const canSeeUnassigned = req.user.role === 'QualityEngineer' || req.user.role === 'Auditor';
  let sql = 'SELECT * FROM dead_letters WHERE lab_id = $1';
  if (canSeeUnassigned) {
    sql = 'SELECT * FROM dead_letters WHERE lab_id = $1 OR lab_id IS NULL';
  }
  sql += ' ORDER BY id DESC LIMIT $2';
  const result = await db.query(sql, [req.user.lab_id, limit]);
  res.json(result.rows);
});

module.exports = router;
