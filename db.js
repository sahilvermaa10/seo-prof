const { Pool } = require('pg');

const databaseUrl = String(process.env.DATABASE_URL || '').trim();
if (!databaseUrl) {
    throw new Error('DATABASE_URL is required. Configure PostgreSQL before starting the application.');
}

const isProduction = process.env.NODE_ENV === 'production';
const pool = new Pool({
    connectionString: databaseUrl,
    // Managed Postgres (Render, Neon, Supabase...) needs TLS. Set DB_SSL=false for a local/private
    // database, or DB_SSL_REJECT_UNAUTHORIZED=true to also verify the server certificate.
    ssl: String(process.env.DB_SSL || '').toLowerCase() === 'false'
        ? undefined
        : (isProduction || String(process.env.DB_SSL || '').toLowerCase() === 'true')
            ? { rejectUnauthorized: String(process.env.DB_SSL_REJECT_UNAUTHORIZED || '').toLowerCase() === 'true' }
            : undefined,
    max: Number(process.env.DB_POOL_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS || 30000)
});

pool.on('error', (error) => console.error('PostgreSQL pool error:', error));

async function query(text, params) {
    return pool.query(text, params);
}

async function health() {
    const result = await query('SELECT NOW() AS now');
    return { ok: true, now: result.rows[0].now };
}

async function close() {
    await pool.end();
}

module.exports = { pool, query, health, close };
