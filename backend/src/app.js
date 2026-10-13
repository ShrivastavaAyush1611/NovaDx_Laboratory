const express = require('express');
const cors = require('cors');
const { requireLogin } = require('./middleware/auth');

const app = express();
app.use(cors());

app.use('/api/ingest', require('./routes/ingest'));

app.use(express.json({ limit: '5mb' }));

app.use('/api/auth', require('./routes/auth'));

app.use('/api', requireLogin);
app.use('/api/results', require('./routes/results'));
app.use('/api/review', require('./routes/review'));
app.use('/api/dead-letters', require('./routes/deadLetters'));
app.use('/api/rules', require('./routes/rules'));
app.use('/api/alerts', require('./routes/alerts'));
app.use('/api/qc', require('./routes/qc'));
app.use('/api/impact', require('./routes/impact'));
app.use('/api/audit', require('./routes/audit'));
app.use('/api/settings', require('./routes/settings'));

app.use(function (req, res) {
  res.status(404).json({ error: 'Not found' });
});

app.use(function (err, req, res, next) {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  const status = err.status || 500;
  if (status === 500) {
    console.error('Server error:', err);
  }
  res.status(status).json({ error: err.message, details: err.details });
});

module.exports = app;
