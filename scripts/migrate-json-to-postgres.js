require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { query, close } = require('../db');

const DATA = path.join(__dirname, '..', 'data');
function readJson(name, fallback) {
    const file = path.join(DATA, name);
    if (!fs.existsSync(file)) return fallback;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

async function main() {
    await query('BEGIN');
    try {
        const users = readJson('users.json', []);
        for (const user of users) {
            await query(`
                INSERT INTO users (id, username, email, password_hash, role, created_at)
                VALUES ($1,$2,$3,$4,$5,$6)
                ON CONFLICT (id) DO NOTHING
            `, [user.id, user.username, user.email, user.passwordHash, user.role === 'admin' ? 'admin' : 'user', user.createdAt || new Date()]);
        }

        const projects = readJson('projects.json', {});
        for (const [userId, list] of Object.entries(projects)) {
            for (const project of (list || [])) {
                await query(`
                    INSERT INTO projects (id, user_id, name, url, created_at, last_audit_at)
                    VALUES ($1,$2,$3,$4,$5,$6)
                    ON CONFLICT (id) DO NOTHING
                `, [project.id || crypto.randomUUID(), userId, project.name || project.url, project.url, project.createdAt || new Date(), project.lastAuditAt || null]);
            }
        }

        const rankHistory = readJson('rank_history.json', {});
        for (const [userId, snapshots] of Object.entries(rankHistory)) {
            for (const snap of (snapshots || [])) {
                await query(`
                    INSERT INTO rank_snapshots (id, user_id, url, country, snapshot_at, keywords)
                    VALUES ($1,$2,$3,$4,$5,$6::jsonb)
                    ON CONFLICT (id) DO NOTHING
                `, [crypto.randomUUID(), userId, snap.url, snap.country || null, snap.date || new Date(), JSON.stringify(snap.keywords || [])]);
            }
        }

        const monitorJobs = readJson('monitor_jobs.json', {});
        for (const [userId, jobs] of Object.entries(monitorJobs)) {
            for (const job of (jobs || [])) {
                await query(`
                    INSERT INTO monitor_jobs (id, user_id, url, every_hours, next_run_at, enabled, last_run_at, created_at)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                    ON CONFLICT (id) DO NOTHING
                `, [job.id || crypto.randomUUID(), userId, job.url, Number(job.everyHours || 24), job.nextRunAt || new Date(), Boolean(job.enabled), job.lastRunAt || null, job.createdAt || new Date()]);
            }
        }

        const alerts = readJson('alerts.json', {});
        for (const [userId, list] of Object.entries(alerts)) {
            for (const alert of (list || [])) {
                await query(`
                    INSERT INTO alerts (id, user_id, url, created_at, score, critical, warnings, message)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                    ON CONFLICT (id) DO NOTHING
                `, [alert.id || crypto.randomUUID(), userId, alert.url || null, alert.createdAt || new Date(), alert.score ?? null, Number(alert.critical || 0), Number(alert.warnings || 0), alert.message || 'SEO alert']);
            }
        }

        await query('COMMIT');
        console.log(`Migration complete: ${users.length} users imported.`);
    } catch (error) {
        await query('ROLLBACK');
        throw error;
    } finally {
        await close();
    }
}

main().catch(error => { console.error('Migration failed:', error); process.exit(1); });
