process.env.NODE_ENV = 'test';
const db = require('../src/db');
const { setupDatabase } = require('../scripts/setupDb');
const qcMonitor = require('../src/services/qcMonitor');

async function resetDatabase() {
  await setupDatabase(db.connectionString, { quiet: true });
  qcMonitor.reset();
}

let sampleCounter = 0;

function makeMessage(overrides) {
  sampleCounter++;
  return Object.assign({
    sample_id: 'S-T' + sampleCounter,
    patient: 'P-7731',
    analyte: 'K',
    value: 4.1,
    unit: 'mmol/L',
    instrument: 'INS-02',
    reagent_lot: 'LOT-A114',
    h_index: 12,
    i_index: 3,
    l_index: 5,
    timestamp: '2026-03-04T09:15:22+05:30'
  }, overrides || {});
}

function auth(username) {
  return { Authorization: 'Bearer token-' + username };
}

async function addSecondLab() {
  const { hashPassword } = require('../src/utils');
  await db.query("INSERT INTO labs (id, name) VALUES ('LAB-2', 'Test-only second lab')");
  await db.query("INSERT INTO instruments (id, lab_id) VALUES ('INS-03', 'LAB-2')");
  const users = [['tech2', 'LabTechnician'], ['qe2', 'QualityEngineer'], ['super2', 'LabSupervisor'], ['auditor2', 'Auditor']];
  for (const u of users) {
    await db.query('INSERT INTO users (username, password_hash, role, lab_id, token) VALUES ($1, $2, $3, $4, $5)',
      [u[0], hashPassword('password123'), u[1], 'LAB-2', 'token-' + u[0]]);
  }
}

async function count(table) {
  const res = await db.query('SELECT COUNT(*)::int AS c FROM ' + table);
  return res.rows[0].c;
}

module.exports = { db, resetDatabase, addSecondLab, makeMessage, auth, count };
