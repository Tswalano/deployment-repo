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

export interface AppStatus {
  project: string; domain: string | null; service: string; active: string; healthy: boolean;
  healthCode: number | null; healthMs: number | null; memory: number | null; restarts: number | null;
  uptimeSeconds: number | null; sha: string | null; subject: string | null; db: string | null;
  warnings24h: number; errors24h: number;
  lastDeploy: { at: string; status: string; durationS: number; actor: string } | null;
}
export interface DeployEvent { project: string; action: string; status: string; at: string; durationS: number; actor: string; fromSha: string; toSha: string; trigger?: string | null; runUrl?: string | null; instance?: string }
export interface Snapshot {
  source: 'agent' | 'basic';
  collectedAt: string;
  host: {
    hostname: string; uptimeSeconds: number; cpus: number; load: number[];
    memory: { total: number; used: number; available: number }; swap: { total: number; used: number };
    disk: { total: number; used: number; free: number }; instanceType?: string; az?: string;
  };
  apps: AppStatus[];
  services: { unit: string; active: string; memory: number | null }[];
  databases: { name: string; size: number; tables: number | null; connections: number; xactCommit?: number | null; deadlocks?: number | null }[];
  dbServer?: {
    version: string; startedAt: string | null; maxConnections: number | null; sharedBuffers: string | null;
    connectionsByState: Record<string, number>; cacheHitPct: number | null; longRunningQueries: number | null;
    idleInTransaction: number | null; oldestXactS: number | null; waitingLocks: number | null;
  } | null;
  certificates: { domain: string; daysLeft: number | null }[];
  backups: { at: string; ok: boolean } | null;
  deploying: { project: string; step: string; actor: string; state: string } | null;
  deployEvents: DeployEvent[];
  runningServices?: number;
}
export interface Instance {
  id: number; name: string; awsInstanceId: string; region: string; environment: string;
  createdAt: string; lastFetchedAt: string | null; lastOkAt: string | null; lastError: string | null;
  status: Snapshot | null;
}
export interface Sample { instanceId?: number; at: string; memPct: number | null; diskPct: number | null; load1: number | null; swapPct: number | null; appsHealthy: number | null; appsTotal: number | null }
export interface Overview {
  generatedAt: string;
  kpis: { instances: number; instancesOnline: number; appsTotal: number; appsHealthy: number; warnings24h: number; errors24h: number;
          memPct: number | null; diskPct: number | null; databases: number; certificatesExpiringSoon: number; deploying: Snapshot['deploying'][] };
  instances: Instance[];
  samples: Sample[];
  activity: DeployEvent[];
}

export interface Deployment {
  id: number; instanceId: number; project: string; action: 'deploy' | 'rollback'; ref: string; requestedBy: string;
  status: 'running' | 'success' | 'failed'; ssmStatus: string | null; createdAt: string; finishedAt: string | null;
  output?: string | null; instance?: string;
}
export interface AppView {
  instance: { id: number; name: string; awsInstanceId: string; region: string; environment: string; lastOkAt: string | null; lastError: string | null };
  app: AppStatus;
  database: Snapshot['databases'][number] | null;
  certificate: Snapshot['certificates'][number] | null;
  deploying: Snapshot['deploying'];
  events: DeployEvent[];
  deployments: Deployment[];
  canOperate: boolean;
}

export interface DbPoint { at: string; size: number | null; connections: number | null; tps: number | null; cacheHitPct: number | null; deadlocks: number | null }
export interface Commit { sha: string; subject: string; author: string; date: string }
export interface AppDetailData {
  branch: string;
  deploySummary: { deploys7d: number; successRate7d: number | null; medianDurationS: number | null } | null;
  unit: { active: string; sub?: string; result?: string; restarts: number | null; memory: number | null; tasks: number | null; cpuSeconds: number | null;
          startedAt: string | null; uptimeSeconds: number | null; enabled: string | null; user?: string | null; unitFile?: string | null;
          workingDir?: string | null; env?: { name: string; value: string | null }[] };
  health: { url?: string; code: number | null; ms: number | null; contentType: string | null; body?: string | null };
  git: { sha: string | null; subject: string | null; author: string | null; date: string | null; tracking: string | null; behind: number | null;
         lastFetch: string | null; commits: Commit[]; upstream: Commit[]; dirty: string[] | number };
  warnings24h: { count: number; errors: number } | null;
  config: Record<string, string> | null;
  fetchError: string | null;
  database: null | { ok: false; error: string } | {
    ok: true; name: string; size: number; blocked: number | null; statsReset: string | null; migrationsApplied: number | null;
    stats: { xact_commit?: number; xact_rollback?: number; deadlocks?: number; temp_files?: number; temp_bytes?: number; cache_hit_pct?: number;
             tup_inserted?: number; tup_updated?: number; tup_deleted?: number; tup_fetched?: number };
    tableCount: number; rows: number; deadRows: number;
    activeQueries: { pid: number; state: string; seconds: number; wait: string | null; app?: string; user?: string }[];
    connectionsByState: Record<string, number>;
    tables?: { table: string; rows: number | null; dead: number; size: number; indexSize: number; seqScans: number; idxScans: number;
               inserts: number; updates: number; deletes: number; lastVacuum: string | null; lastAnalyze: string | null }[];
    unusedIndexes?: { index: string; table: string; size: number }[];
    migrationsTable?: string | null;
  };
}
export interface LogEntry { ts: number; level: 'error' | 'warning' | 'info' | 'debug'; source: string; message: string }
export interface LogsResult { entries: LogEntry[]; byLevel: Record<string, number>; source: string; truncated: boolean; fetchedAt: string }

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
  overview: () => call<Overview>('GET', '/api/instances/overview'),
  instances: () => call<{ instances: Instance[] }>('GET', '/api/instances').then((r) => r.instances),
  instance: (id: number, refresh = false) =>
    call<{ instance: Instance; samples: Sample[]; dbSeries: Record<string, DbPoint[]> }>('GET', `/api/instances/${id}${refresh ? '?refresh=1' : ''}`),
  addInstance: (b: { awsInstanceId: string; region: string; name: string; environment: string }) =>
    call<{ instance: Instance }>('POST', '/api/instances', b).then((r) => r.instance),
  updateInstance: (id: number, b: { name?: string; environment?: string }) =>
    call<{ instance: Instance }>('PATCH', `/api/instances/${id}`, b).then((r) => r.instance),
  removeInstance: (id: number) => call('DELETE', `/api/instances/${id}`),
  appView: (id: number, project: string) => call<AppView>('GET', `/api/instances/${id}/apps/${encodeURIComponent(project)}`),
  startDeployment: (id: number, project: string, action: 'deploy' | 'rollback', ref: string) =>
    call<{ deployment: Deployment }>('POST', `/api/instances/${id}/apps/${encodeURIComponent(project)}/${action}`, { ref }).then((r) => r.deployment),
  deployment: (id: number) => call<{ deployment: Deployment }>('GET', `/api/deployments/${id}`).then((r) => r.deployment),
  appDetail: (id: number, project: string, fetch = false) =>
    call<{ detail: AppDetailData; dbSeries: DbPoint[]; fetchedAt: string }>('GET', `/api/instances/${id}/apps/${encodeURIComponent(project)}/detail${fetch ? '?fetch=1' : ''}`),
  appLogs: (id: number, project: string, o: { lines: number; level: string; since: string; q: string }) =>
    call<LogsResult>('GET', `/api/instances/${id}/apps/${encodeURIComponent(project)}/logs?${new URLSearchParams({ lines: String(o.lines), level: o.level, since: o.since, q: o.q })}`),
  audit: (limit = 100) => call<{ entries: AuditEntry[] }>('GET', `/api/audit?limit=${limit}`).then((r) => r.entries),
};

export const ROLE_INFO: Record<Role, { label: string; description: string; badge: string }> = {
  admin: { label: 'Admin', description: 'Everything, including users and instances', badge: 'pill border-violet-400/30 bg-violet-500/10 text-violet-300' },
  deployer: { label: 'Deployer', description: 'Read everything and deploy applications', badge: 'pill border-sky-400/30 bg-sky-500/10 text-sky-300' },
  viewer: { label: 'Viewer', description: 'Read-only', badge: 'pill-mute' },
};

export const ago = (iso: string | null): string => {
  if (!iso) return 'never';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};
