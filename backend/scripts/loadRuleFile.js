const fs = require('fs');
const path = require('path');
const { createRuleSet } = require('../src/services/ruleSets');
const db = require('../src/db');

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.log('Usage: npm run rules:load -- <path to rules json>');
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const saved = await createRuleSet(config, config.effective_from || new Date().toISOString(), config.description, 'rules-file:' + path.basename(file));
  console.log('Saved rule set version ' + saved.version + ' (effective from ' + saved.effective_from.toISOString() + ')');
  await db.pool.end();
}

main().catch(function (err) {
  console.error(err.message);
  process.exit(1);
});
