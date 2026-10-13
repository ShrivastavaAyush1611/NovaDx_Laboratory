const express = require('express');
const db = require('../db');
const { hashPassword } = require('../utils');
const { requireLogin } = require('../middleware/auth');
const { addAuditEntry } = require('../services/audit');

const router = express.Router();

router.post('/login', async function (req, res) {
  const username = req.body.username;
  const password = req.body.password;
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }
  const result = await db.query('SELECT * FROM users WHERE username = $1', [username]);
  const user = result.rows[0];
  if (!user || user.password_hash !== hashPassword(password)) {
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  await addAuditEntry(user, 'LOGIN', {});
  res.json({
    token: user.token,
    user: { username: user.username, role: user.role, lab_id: user.lab_id }
  });
});

router.get('/demo-users', async function (req, res) {
  const result = await db.query('SELECT username, role, lab_id FROM users ORDER BY lab_id, id');
  res.json(result.rows);
});

router.get('/me', requireLogin, function (req, res) {
  res.json(req.user);
});

module.exports = router;
