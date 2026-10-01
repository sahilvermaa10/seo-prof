require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { query, close } = require('../db');

async function main() {
  const sqlPath = path.join(__dirname, '..', 'db', 'activity-schema.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  console.log(`Running ${sqlPath} ...`);
  await query(sql);
  console.log('Done. Created (if not already present): user_activity, api_usage, login_history.');
}

main().catch(err => { console.error('Migration failed:', err.message); process.exitCode = 1; }).finally(() => close().catch(() => {}));
