const express = require('express');
const { requireAnalyzerKey } = require('../middleware/auth');
const { ingestMessage, saveDeadLetter } = require('../services/ingestService');

const router = express.Router();

router.use(express.text({ type: '*/*', limit: '5mb' }));

function parseBody(text) {
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: 'invalid JSON: ' + err.message };
  }
}

router.post('/', requireAnalyzerKey, async function (req, res) {
  const parsed = parseBody(req.body);
  if (!parsed.ok) {
    const id = await saveDeadLetter(String(req.body), parsed.error, null);
    return res.status(422).json({ status: 'dead_letter', dead_letter_id: id, reason: parsed.error });
  }
  const outcome = await ingestMessage(parsed.data);
  if (outcome.status === 'stored') return res.status(201).json(outcome);
  if (outcome.status === 'duplicate') return res.status(200).json(outcome);
  return res.status(422).json(outcome);
});

router.post('/batch', requireAnalyzerKey, async function (req, res) {
  const parsed = parseBody(req.body);
  if (!parsed.ok || !Array.isArray(parsed.data)) {
    const reason = parsed.ok ? 'batch body must be a JSON list' : parsed.error;
    const id = await saveDeadLetter(String(req.body), reason, null);
    return res.status(422).json({ status: 'dead_letter', dead_letter_id: id, reason: reason });
  }
  const summary = { stored: 0, duplicate: 0, dead_letter: 0 };
  const outcomes = [];
  for (const message of parsed.data) {
    const outcome = await ingestMessage(message);
    summary[outcome.status]++;
    outcomes.push(outcome);
  }
  res.json({ summary: summary, outcomes: outcomes });
});

module.exports = router;
