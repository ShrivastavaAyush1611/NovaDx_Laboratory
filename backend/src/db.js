const { Pool } = require('pg');
require('dotenv').config({ path: __dirname + '/../.env', quiet: true });

let connectionString = process.env.DATABASE_URL;
if (process.env.NODE_ENV === 'test') {
  connectionString = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5432/novadx_test';
}

const pool = new Pool({
  connectionString: connectionString,
  max: 20
});

pool.on('error', function (err) {
  console.log('Postgres pool error:', err.message);
});

async function query(text, params) {
  return pool.query(text, params);
}

module.exports = { pool, query, connectionString };
