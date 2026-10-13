const express = require('express');
const { requireRole } = require('../middleware/auth');
const qcMonitor = require('../services/qcMonitor');

const router = express.Router();
const QC_ROLES = ['LabTechnician', 'QualityEngineer', 'LabSupervisor'];

router.get('/moving-average', requireRole(...QC_ROLES), async function (req, res) {
  const analyte = req.query.analyte || 'K';
  let windowSize = parseInt(req.query.window, 10) || 50;
  if (windowSize < 5) windowSize = 5;
  if (windowSize > 1000) windowSize = 1000;
  const data = await qcMonitor.getMovingAverage(req.user.lab_id, analyte, windowSize);
  res.json(data);
});

module.exports = router;
