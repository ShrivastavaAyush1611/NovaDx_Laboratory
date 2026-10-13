const app = require('./app');
const qcMonitor = require('./services/qcMonitor');
const alertService = require('./services/alertService');

const PORT = process.env.PORT || 5050;

async function start() {
  console.log('Loading QC state from the database...');
  const count = await qcMonitor.init();
  console.log('QC detector ready (' + count + ' results replayed)');

  const server = app.listen(PORT, function (err) {
    if (err) return;
    console.log('NovaDx API running on http://localhost:' + PORT);
  });
  server.on('error', function (err) {
    if (err.code === 'EADDRINUSE') {
      console.error('Port ' + PORT + ' is already used by another program. Change PORT in backend/.env');
    } else {
      console.error('Server error:', err.message);
    }
    process.exit(1);
  });

  let sending = false;
  setInterval(async function () {
    if (sending) return;
    sending = true;
    try {
      await alertService.processPendingNotifications();
    } catch (err) {
      console.log('Notification worker error:', err.message);
    }
    sending = false;
  }, 2000);

  setInterval(async function () {
    try {
      const escalated = await alertService.checkEscalations();
      if (escalated.length > 0) console.log('Escalated ' + escalated.length + ' alert(s)');
    } catch (err) {
      console.log('Escalation job error:', err.message);
    }
  }, 15000);
}

start().catch(function (err) {
  console.error('Could not start server:', err.message);
  console.error('Is PostgreSQL running and did you run "npm run db:setup"?');
  process.exit(1);
});
