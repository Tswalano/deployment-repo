import { db } from './db';

export interface Actor {
    id: number | null;
    username: string | null;
}

export async function audit(actor: Actor | null, action: string, target: string | null, detail: Record<string, unknown>, ip: string | null): Promise<void> {
    try {
        await db().query(
            'INSERT INTO audit_log (user_id, username, action, target, detail, ip) VALUES ($1, $2, $3, $4, $5, $6)',
            [actor?.id ?? null, actor?.username ?? null, action, target, JSON.stringify(detail), ip]);
    } catch (err) {
        // Auditing must never break the request; surface it in the service log instead.
        console.error('audit write failed:', (err as Error).message, action);
    }
}
