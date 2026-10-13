
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '../.env'), quiet: true });
const { hashPassword } = require('../src/utils');

const labsConfig = require('../config/labs.json');

async function createDatabaseIfMissing(connectionString) {
  const url = new URL(connectionString);
  const dbName = url.pathname.replace('/', '');
  url.pathname = '/postgres';
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  const res = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (res.rows.length === 0) {
    console.log('Creating database ' + dbName);
    await client.query('CREATE DATABASE "' + dbName + '"');
  }
  await client.end();
}

async function setupDatabase(connectionString, options) {
  options = options || {};
  await createDatabaseIfMissing(connectionString);

  const client = new Client({ connectionString: connectionString });
  await client.connect();
  await client.query('SET client_min_messages TO WARNING');

  const schema = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8');
  await client.query(schema);

  for (const lab of labsConfig.labs) {
    await client.query('INSERT INTO labs (id, name) VALUES ($1, $2)', [lab.id, lab.name]);
  }
  for (const ins of labsConfig.instruments) {
    await client.query('INSERT INTO instruments (id, lab_id) VALUES ($1, $2)', [ins.id, ins.lab_id]);
  }
  for (const u of labsConfig.users) {
    // token is fixed per user so the demo is easy to use (e.g. "token-tech1")
    await client.query(
      'INSERT INTO users (username, password_hash, role, lab_id, token) VALUES ($1, $2, $3, $4, $5)',
      [u.username, hashPassword(labsConfig.default_password), u.role, u.lab_id, 'token-' + u.username]
    );
  }
  for (const key of Object.keys(labsConfig.settings)) {
    await client.query('INSERT INTO settings (key, value) VALUES ($1, $2)', [key, labsConfig.settings[key]]);
  }

  const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/rules/ruleset_v1.json'), 'utf8'));
  await client.query(
    'INSERT INTO rule_sets (version, effective_from, description, config, created_by) VALUES (1, $1, $2, $3, $4)',
    [rules.effective_from, rules.description, JSON.stringify(rules), 'setup-script']
  );

  await client.end();
  if (!options.quiet) {
    console.log('Database ready: ' + connectionString);
    console.log('Demo users (password: ' + labsConfig.default_password + '):');
    for (const u of labsConfig.users) {
      console.log('  ' + u.username.padEnd(10) + u.role.padEnd(18) + u.lab_id);
    }
  }
}

module.exports = { setupDatabase };

if (require.main === module) {
  const target = process.argv[2] === '--test' ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
  setupDatabase(target).catch(function (err) {
    console.error('Setup failed:', err.message);
    process.exit(1);
  });
}
