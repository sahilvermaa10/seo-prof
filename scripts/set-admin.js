require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const { query, close } = require('../db');

async function main() {
  const email = String(process.argv[2] || '').trim().toLowerCase();
  if (!email) throw new Error('Usage: npm run db:make-admin -- user@example.com');
  const result = await query(`UPDATE users SET role='admin', updated_at=NOW() WHERE LOWER(email)=LOWER($1) RETURNING id, username, email, role`, [email]);
  if (!result.rows[0]) {
    const db = await query('SELECT current_database() AS database, current_user AS db_user');
    throw new Error(`No user found for ${email}. Connected to database "${db.rows[0].database}" as "${db.rows[0].db_user}". Run "npm run db:admin-info" to inspect the accounts in this database.`);
  }
  console.log(`Admin role granted to ${result.rows[0].username} (${result.rows[0].email}).`);
}

main().catch(err => { console.error(err.message); process.exitCode = 1; }).finally(() => close().catch(() => {}));
