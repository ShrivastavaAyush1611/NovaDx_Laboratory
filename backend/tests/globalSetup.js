const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env'), quiet: true });
const { setupDatabase } = require('../scripts/setupDb');

module.exports = async function () {
  const url = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5432/novadx_test';
  await setupDatabase(url, { quiet: true });
};
