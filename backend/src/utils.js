const crypto = require('crypto');

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  const parts = [];
  for (const k of keys) {
    if (obj[k] === undefined) continue;
    parts.push(JSON.stringify(k) + ':' + stableStringify(obj[k]));
  }
  return '{' + parts.join(',') + '}';
}

function hashPassword(password) {
  return sha256('novadx-salt:' + password);
}

function randomToken() {
  return crypto.randomBytes(24).toString('hex');
}


function localHour(timestampText) {
  const match = /T(\d{2}):/.exec(timestampText);
  if (match) return parseInt(match[1], 10);
  return new Date(timestampText).getUTCHours();
}

module.exports = { sha256, stableStringify, hashPassword, randomToken, localHour };
