import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'crypto';

// scrypt from Node's standard library: no native add-ons to compile on the server.
// Stored as: scrypt$N$r$p$<salt b64>$<hash b64>
const N = 16384, R = 8, P = 1, KEYLEN = 64;

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
    return new Promise((resolve, reject) =>
        scryptCb(password, salt, KEYLEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))));
}

export const MIN_PASSWORD_LENGTH = 8;

export function passwordProblem(password: unknown): string | null {
    if (typeof password !== 'string') return 'Password is required.';
    if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    if (password.length > 200) return 'Password is too long.';
    return null;
}

export async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const key = await scrypt(password, salt, N, R, P);
    return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
    if (!stored) return false;
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, n, r, p, salt, hash] = parts;
    const expected = Buffer.from(hash, 'base64');
    const actual = await scrypt(password, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A fixed hash used to spend the same time on unknown usernames (no user-enumeration timing). */
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
    if (!dummyHash) dummyHash = hashPassword(randomBytes(16).toString('hex'));
    return dummyHash;
}
