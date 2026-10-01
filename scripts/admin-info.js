require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const { query, close } = require('../db');

async function main() {
  const identifier = String(process.argv[2] || '').trim().toLowerCase();
  const db = await query('SELECT current_database() AS database, current_user AS db_user, inet_server_addr() AS host, inet_server_port() AS port');
  console.log(`Database: ${db.rows[0].database}`);
  console.log(`DB user:  ${db.rows[0].db_user}`);
  console.log(`Server:   ${db.rows[0].host || 'local'}:${db.rows[0].port || ''}`);
  const users = await query(`
    SELECT id, username, email, role, created_at AS "createdAt"
    FROM users
    ${identifier ? 'WHERE LOWER(email)=LOWER($1) OR LOWER(username)=LOWER($1)' : ''}
    ORDER BY created_at DESC LIMIT 50
  `, identifier ? [identifier] : []);
  if (!users.rows.length) {
    console.log(identifier ? `No user found for ${identifier}` : 'No users found.');
    return;
  }
  for (const u of users.rows) {
    console.log(`${u.username} | ${u.email} | role=${u.role} | id=${u.id}`);
  }
}
main().catch(e => { console.error('Admin info failed:', e.message); process.exitCode = 1; })
  .finally(() => close().catch(() => {}));
