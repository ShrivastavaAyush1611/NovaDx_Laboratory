const logChannel = require('./logChannel');

const channels = {
  log: logChannel
};

function getChannel() {
  const name = process.env.NOTIFY_CHANNEL || 'log';
  if (!channels[name]) {
    console.log('Unknown NOTIFY_CHANNEL "' + name + '", using log');
    return logChannel;
  }
  return channels[name];
}

module.exports = { getChannel, channels };
