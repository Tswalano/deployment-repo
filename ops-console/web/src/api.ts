export type Role = 'admin' | 'deployer' | 'viewer';

export interface Me {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  isDemo: boolean;
}

export interface User {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  isDemo: boolean;
  disabled: boolean;
  locked: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface AuditEntry {
  id: number;
  at: string;
  username: string | null;
  action: string;
  target: string | null;
  detail: Record<string, unknown>;
  ip: string | null;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error || `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  me: () => call<{ user: Me }>('GET', '/api/auth/me').then((r) => r.user),
  login: (username: string, password: string) => call('POST', '/api/auth/login', { username, password }),
  demo: () => call('POST', '/api/auth/demo', {}),
  logout: () => call('POST', '/api/auth/logout', {}),
  changePassword: (currentPassword: string, newPassword: string) =>
    call('POST', '/api/auth/password', { currentPassword, newPassword }),
  users: () => call<{ users: User[] }>('GET', '/api/users').then((r) => r.users),
  createUser: (u: { username: string; displayName: string; role: Role; password: string }) =>
    call<{ user: User }>('POST', '/api/users', u).then((r) => r.user),
  updateUser: (id: number, patch: Partial<Pick<User, 'role' | 'disabled' | 'displayName'>>) =>
    call<{ user: User }>('PATCH', `/api/users/${id}`, patch).then((r) => r.user),
  resetPassword: (id: number, password: string) => call('POST', `/api/users/${id}/password`, { password }),
  deleteUser: (id: number) => call('DELETE', `/api/users/${id}`),
  audit: (limit = 100) => call<{ entries: AuditEntry[] }>('GET', `/api/audit?limit=${limit}`).then((r) => r.entries),
};

export const ROLE_INFO: Record<Role, { label: string; description: string; badge: string }> = {
  admin: { label: 'Admin', description: 'Everything, including users and instances', badge: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300' },
  deployer: { label: 'Deployer', description: 'Read everything and deploy applications', badge: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300' },
  viewer: { label: 'Viewer', description: 'Read-only', badge: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
};

export const ago = (iso: string | null): string => {
  if (!iso) return 'never';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};
