const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '../../logs/notifications.log');

const logChannel = {
  name: 'log',
  send: async function (notification, alert) {
    const line = new Date().toISOString() +
      ' [' + notification.kind + '] to ' + notification.recipient + ' @ ' + notification.lab_id +
      ' | alert #' + alert.id + ' ' + alert.type + ' (' + alert.state + ', seen ' + alert.occurrences + 'x): ' + alert.message + '\n';
    fs.appendFileSync(LOG_FILE, line);
    if (process.env.NODE_ENV !== 'test') {
      console.log('NOTIFY ' + line.trim());
    }
  }
};

module.exports = logChannel;
