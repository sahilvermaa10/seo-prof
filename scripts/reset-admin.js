require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const crypto = require('crypto');
const readline = require('readline');
const { query, close } = require('../db');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (err, derived) => {
    if (err) return reject(err);
    resolve(`${salt}:${derived.toString('hex')}`);
  }));
}
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer); }));
}
async function main() {
  const identifier = String(process.argv[2] || '').trim().toLowerCase();
  if (!identifier) throw new Error('Usage: npm run db:reset-admin -- user@example.com');
  const found = await query(
    `SELECT id, username, email, role FROM users WHERE LOWER(email)=LOWER($1) OR LOWER(username)=LOWER($1) LIMIT 1`,
    [identifier]
  );
  if (!found.rows[0]) throw new Error(`No user found for ${identifier}. Run: npm run db:admin-info`);
  const u = found.rows[0];
  const password = await ask(`Enter NEW password for ${u.username}: `);
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new Error('Password must be at least 8 characters and include a letter and a number.');
  }
  const passwordHash = await hashPassword(password);
  const updated = await query(
    `UPDATE users SET password_hash=$1, role='admin', updated_at=NOW() WHERE id=$2 RETURNING username,email,role`,
    [passwordHash, u.id]
  );
  await query(`DELETE FROM sessions WHERE user_id=$1`, [u.id]);
  console.log(`Admin account ready: ${updated.rows[0].username} (${updated.rows[0].email})`);
  console.log('All old sessions were signed out. Use the NEW password to sign in.');
}
main().catch(e => { console.error('Admin password reset failed:', e.message); process.exitCode = 1; })
  .finally(() => close().catch(() => {}));
