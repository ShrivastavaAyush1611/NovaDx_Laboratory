const express = require('express');
const { requireRole } = require('../middleware/auth');
const ruleSets = require('../services/ruleSets');
const { dryRun } = require('../services/dryRun');
const { addAuditEntry } = require('../services/audit');

const router = express.Router();
const ALL_ROLES = ['LabTechnician', 'QualityEngineer', 'LabSupervisor', 'Auditor'];

router.get('/', requireRole(...ALL_ROLES), async function (req, res) {
  const all = await ruleSets.loadAllRuleSets();
  const active = await ruleSets.getActiveRuleSet(new Date());
  res.json({
    active_version: active.version,
    versions: all.map(function (rs) {
      return {
        version: rs.version,
        effective_from: rs.effective_from,
        description: rs.description,
        created_by: rs.created_by,
        created_at: rs.created_at,
        rule_count: rs.config.rules.length
      };
    })
  });
});

router.get('/:version', requireRole(...ALL_ROLES), async function (req, res) {
  if (!/^\d+$/.test(req.params.version)) return res.status(404).json({ error: 'Rule set not found' });
  const rs = await ruleSets.getRuleSet(req.params.version);
  if (!rs) return res.status(404).json({ error: 'Rule set not found' });
  res.json(rs);
});

router.post('/', requireRole('QualityEngineer'), async function (req, res) {
  const saved = await ruleSets.createRuleSet(req.body.config, req.body.effective_from, req.body.description, req.user.username);
  await addAuditEntry(req.user, 'RULE_SET_CREATED', {
    version: saved.version, effective_from: saved.effective_from, description: saved.description
  });
  res.status(201).json(saved);
});

router.post('/dry-run', requireRole('QualityEngineer'), async function (req, res) {
  const report = await dryRun(req.body.config);
  await addAuditEntry(req.user, 'RULE_SET_DRY_RUN', {
    total_results: report.total_results, would_change: report.would_change
  });
  res.json(report);
});

module.exports = router;
