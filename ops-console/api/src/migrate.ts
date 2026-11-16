import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { db } from './db';

/** Apply migrations/*.sql in name order, once each, each in its own transaction. */
export async function migrate(dir = join(__dirname, '..', 'migrations')): Promise<string[]> {
    const client = await db().connect();
    const applied: string[] = [];
    try {
        await client.query('SELECT pg_advisory_lock(726371)');   // one migrator at a time
        await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
            name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
        const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
        for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
            if (done.has(file)) continue;
            await client.query('BEGIN');
            try {
                await client.query(readFileSync(join(dir, file), 'utf8'));
                await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
                await client.query('COMMIT');
                applied.push(file);
            } catch (err) {
                await client.query('ROLLBACK');
                throw new Error(`migration ${file} failed: ${(err as Error).message}`);
            }
        }
    } finally {
        await client.query('SELECT pg_advisory_unlock(726371)').catch(() => undefined);
        client.release();
    }
    return applied;
}
