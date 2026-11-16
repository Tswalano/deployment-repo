import { Pool } from 'pg';
import { config } from './config';

let pool: Pool | null = null;

export function db(): Pool {
    if (!pool) {
        pool = new Pool({ connectionString: config.databaseUrl, max: 5, idleTimeoutMillis: 30_000 });
        pool.on('error', (err) => console.error('postgres pool error:', err.message));
    }
    return pool;
}

/** For tests: point the pool at another database. */
export function setPool(p: Pool | null): void {
    pool = p;
}

export async function closeDb(): Promise<void> {
    if (pool) await pool.end();
    pool = null;
}
