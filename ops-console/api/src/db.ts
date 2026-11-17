import { AsyncLocalStorage } from 'async_hooks';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { config } from './config';

/**
 * Workspace isolation (migration 015): every table of customer data has row-level security keyed on the Postgres
 * setting app.workspace_id. Each query below runs on a connection where that setting (and app.bypass) has just been
 * set from the async context of the request or job that issued it, so one workspace can never read or write
 * another's rows, whatever the query says.
 *
 * Context:
 *  - inside withWorkspace(id, fn): that workspace
 *  - inside asSystem(fn): every workspace (explicit opt-in for jobs that must see all, e.g. expiring SSH grants)
 *  - outside any context: workspace 1 in the single-team console; NONE in multi-tenant mode (sees and writes nothing)
 */
interface DbContext { workspaceId: number | null; system: boolean }
const als = new AsyncLocalStorage<DbContext>();

export const withWorkspace = <T>(workspaceId: number | null, fn: () => Promise<T>): Promise<T> => als.run({ workspaceId, system: false }, fn);
export const asSystem = <T>(fn: () => Promise<T>): Promise<T> => als.run({ workspaceId: null, system: true }, fn);
/** The workspace queries run in right now (null = none, or system). */
export function currentWorkspace(): number | null {
    const ctx = als.getStore();
    if (ctx) return ctx.workspaceId;
    return config.multiTenant ? null : 1;
}

let pool: Pool | null = null;
function rawPool(): Pool {
    if (!pool) {
        pool = new Pool({ connectionString: config.databaseUrl, max: 8, idleTimeoutMillis: 30_000 });
        pool.on('error', (err) => console.error('postgres pool error:', err.message));
    }
    return pool;
}

export interface Db {
    query<R extends QueryResultRow = any>(text: string, values?: unknown[]): Promise<QueryResult<R>>;  // eslint-disable-line @typescript-eslint/no-explicit-any
    /** A raw connection WITHOUT workspace context (migrations only). */
    connect(): Promise<PoolClient>;
}

const scoped: Db = {
    async query(text, values) {
        const ctx = als.getStore();
        const ws = ctx ? ctx.workspaceId : currentWorkspace();
        const system = ctx?.system ?? false;
        const client = await rawPool().connect();
        try {
            await client.query("SELECT set_config('app.workspace_id', $1, false), set_config('app.bypass', $2, false)",
                [ws == null ? '' : String(ws), system ? 'on' : 'off']);
            return await client.query(text, values as unknown[]);
        } finally {
            client.release();
        }
    },
    connect: () => rawPool().connect(),
};

export function db(): Db {
    return scoped;
}

/** Background jobs: run fn once per workspace, each in its own isolation context (errors are logged, not fatal). */
export async function forEachWorkspace(fn: (workspaceId: number) => Promise<void>): Promise<void> {
    const { rows } = await asSystem(() => scoped.query<{ id: number }>('SELECT id FROM workspaces ORDER BY id'));
    for (const w of rows) {
        await withWorkspace(w.id, () => fn(w.id)).catch((err) => console.error(`workspace ${w.id} job failed:`, (err as Error).message));
    }
}

/** For tests: point the pool at another database (or another role). */
export function setPool(p: Pool | null): void {
    pool = p;
}

export async function closeDb(): Promise<void> {
    if (pool) await pool.end();
    pool = null;
}
