const express = require('express');
const { requireRole } = require('../middleware/auth');
const impactService = require('../services/impactService');

const router = express.Router();

router.get('/', requireRole('QualityEngineer', 'LabSupervisor', 'Auditor'), async function (req, res) {
  res.json(await impactService.listImpactCases(req.user.lab_id));
});

router.post('/', requireRole('QualityEngineer', 'LabSupervisor'), async function (req, res) {
  const created = await impactService.createImpactCase(req.body, req.user);
  res.status(201).json(created);
});

router.get('/:id/report', requireRole('QualityEngineer', 'LabSupervisor', 'Auditor'), async function (req, res) {
  const report = await impactService.getImpactReport(req.params.id, req.user.lab_id);
  if (!report) return res.status(404).json({ error: 'Impact case not found' });
  res.json(report);
});

module.exports = router;
