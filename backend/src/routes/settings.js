const express = require('express');
const { requireRole } = require('../middleware/auth');
const settings = require('../services/settings');
const { addAuditEntry } = require('../services/audit');

const router = express.Router();

const EDITABLE = ['escalation_minutes', 'max_notifications_per_hour', 'max_send_attempts'];

router.get('/', requireRole('QualityEngineer', 'LabSupervisor'), async function (req, res) {
  res.json(await settings.getAllSettings());
});

router.put('/', requireRole('LabSupervisor'), async function (req, res) {
  const changed = {};
  for (const key of Object.keys(req.body)) {
    if (!EDITABLE.includes(key)) {
      return res.status(400).json({ error: 'Setting ' + key + ' can not be changed' });
    }
    const value = Number(req.body[key]);
    if (!Number.isFinite(value) || value < 0) {
      return res.status(400).json({ error: key + ' must be a positive number' });
    }
    changed[key] = value;
  }
  for (const key of Object.keys(changed)) {
    await settings.setSetting(key, changed[key]);
  }
  await addAuditEntry(req.user, 'SETTINGS_CHANGED', changed);
  res.json(await settings.getAllSettings());
});

module.exports = router;
