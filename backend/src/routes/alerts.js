const express = require('express');
const db = require('../db');
const { requireRole } = require('../middleware/auth');
const alertService = require('../services/alertService');

const router = express.Router();

router.get('/', requireRole('LabTechnician', 'QualityEngineer', 'LabSupervisor', 'Auditor'), async function (req, res) {
  const result = await db.query(
    `SELECT * FROM alerts WHERE lab_id = $1
     ORDER BY CASE state WHEN 'ESCALATED' THEN 0 WHEN 'OPEN' THEN 1 ELSE 2 END, id DESC LIMIT 200`,
    [req.user.lab_id]
  );
  res.json(result.rows);
});

router.post('/:id/acknowledge', requireRole('LabTechnician', 'QualityEngineer', 'LabSupervisor'), async function (req, res) {
  const alert = await alertService.acknowledgeAlert(req.params.id, req.user);
  if (!alert) return res.status(404).json({ error: 'Alert not found or already acknowledged' });
  res.json(alert);
});

module.exports = router;
