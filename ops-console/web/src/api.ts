export type Role = 'admin' | 'deployer' | 'viewer';

export interface Me {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  isDemo: boolean;
  email: string | null;
  emailVerified: boolean;
  workspaceId: number | null;
}
export interface SiteConfig { multiTenant: boolean; productName: string; trialDays: number }
export interface Workspace { id: number; name: string; slug: string; plan: 'trial' | 'starter' | 'pro' | 'internal'; trialEndsAt: string | null; role: Role }
export interface TeamMember { id: number; username: string; displayName: string; email: string | null; role: Role; joinedAt: string; lastLoginAt: string | null; emailVerified: boolean }
export interface TeamInvite { id: number; email: string; role: Role; createdAt: string; expiresAt: string }

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
  ec2State?: string | null; ec2StateAt?: string | null; isConsoleHost?: boolean;
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
  alerts: AlertCounts;
}

export interface Deployment {
  id: number; instanceId: number; project: string; action: 'deploy' | 'rollback'; ref: string; requestedBy: string;
  status: 'pending_approval' | 'running' | 'success' | 'failed' | 'rejected' | 'expired' | 'cancelled';
  ssmStatus: string | null; createdAt: string; finishedAt: string | null;
  approvedBy: string | null; approvedAt: string | null; decisionReason: string | null; overrideReason: string | null; expiresAt: string | null;
  output?: string | null; instance?: string; environment?: string;
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
  policy: PolicyStatus;
  repo: { repo: string; branch: string; autoDeploy: boolean; linkedBy: string | null } | null;
}
export interface GithubStatus {
  connected: boolean; webhookUrl: string; app?: { slug: string; owner: string; htmlUrl: string };
  installations?: { id: number; account: string; selection: 'all' | 'selected' }[]; installUrl?: string; error?: string;
}
export interface Detection { found: boolean; name: string | null; scripts: string[]; start: string | null; build: boolean; migrate: string | null; healthPath: string; node: string | null; warnings: string[]; frontend?: boolean }
export interface NewAppCheck {
  project: { ok: boolean; reason?: string }; domain: { status: 'free' | 'ours' | 'taken' | 'invalid'; name: string; reason?: string };
  memoryMb: number | null; memoryWarning: string | null; publicIp: string | null; appsDomain: string;
}
export interface NewAppBody {
  project: string; repo: string; branch: string; subdir: string; start: string; build: boolean; migrate: string; healthPath: string;
  subdomain: string; db: boolean; memoryMb: number; confirmLowMemory?: boolean; override?: string;
}
export interface GithubRepo { fullName: string; private: boolean; defaultBranch: string; pushedAt: string | null; description: string | null }
export interface EnvVar { key: string; kind: 'db' | 'jwt' | 'provider' | 'secret' | 'config'; version: number; lastModified: string | null; lastModifiedBy: string | null; generated: boolean }
export interface PolicyStatus {
  freeze: { id: string; name: string; endsAt: string } | null;
  needsApproval: { deploy: boolean; rollback: boolean };
  rollbackAllowedInFreeze: boolean;
  requestTtlMinutes: number;
}
export type EnvName = 'production' | 'staging' | 'development';
export interface FreezeWindow {
  id?: string; name: string; environments: EnvName[]; kind: 'weekly' | 'once';
  startDay?: number; startTime?: string; endDay?: number; endTime?: string; startAt?: string; endAt?: string;
}
export interface DeployPolicy {
  timezone: string; approvals: Record<EnvName, boolean>; rollbackNeedsApproval: boolean; rollbackAllowedInFreeze: boolean;
  requestTtlMinutes: number; freezes: FreezeWindow[];
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

export type Severity = 'critical' | 'warning' | 'info';
export interface Alert {
  id: number; rule: string; severity: Severity; instanceId: number | null; instance: string | null; project: string | null;
  title: string; detail: string; openedAt: string; lastSeenAt: string; resolvedAt: string | null;
  ackedBy: string | null; ackedAt: string | null; notifyCount: number; lastNotifiedAt: string | null;
}
export interface AlertCounts { open: number; critical: number; week?: number }
export interface AlertSettings {
  recipients: string[]; webhookUrl: string; webhookSet: boolean; minSeverity: Severity; repeatHours: number;
  thresholds: { downChecks: number; latencyMs: number; diskPct: number; memoryPct: number; certDays: number; backupHours: number };
  recent: { channel: string; ok: boolean; error: string | null; at: string }[];
}
export interface UptimeApp {
  instanceId: number; instance: string; project: string; domain: string | null; url: string | null;
  last: { at: string; ok: boolean; status: number | null; ms: number | null } | null;
  uptime: { h24: number | null; d7: number | null; d30: number | null; d90: number | null };
  p95ms24h: number | null;
  days: { day: string; checks: number; ok: number; pct: number | null }[];
}
export interface UptimePoint { at: string; checks: number; ok: number; avgMs: number | null; maxMs: number | null }

export interface BackupVerification {
  id: number; db: string; file: string; ok: boolean; tables: number | null; rows: number | null; liveTables: number | null; liveRows: number | null;
  seconds: number | null; error: string | null; trigger: 'auto' | 'manual'; requestedBy: string | null; at: string;
}
export interface InstanceBackups {
  instanceId: number; instance: string; ok: boolean; error?: string; location?: string; diskFree?: number;
  timer?: { next: string | null; last: string | null; running: boolean };
  lastRun?: { at: string; ok: boolean; keepDays: number; totalBytes: number; items: { name: string; ok: boolean; file?: string; bytes?: number; seconds?: number }[] } | null;
  files?: { db: string; file: string; bytes: number; at: string }[];
  verifications: BackupVerification[];
}

export interface Schedule {
  name: string; group: string; action: 'start' | 'stop' | 'unknown'; instanceIds: string[]; expression: string; timezone: string;
  enabled: boolean; next: string | null; time: string | null; days: number[] | null; editable: boolean; skip: { until: string; by: string } | null;
}
export interface CostSummary {
  fetchedAt: string; currency: string; monthToDate: number; lastMonth: number; lastMonthSamePeriod: number; forecast: number; forecastSource: 'aws' | 'linear';
  daily: { day: string; total: number; top?: { name: string; amount: number }[] }[]; services: { name: string; monthToDate: number; lastMonth: number }[];
  period: { monthStart: string; today: string; daysInMonth: number };
}
export interface CostSettings { monthlyBudget: number | null; zarRate: number | null; currency: 'USD' | 'ZAR' }

export interface NewAppCreation {
  id: number; deploymentId: number | null; project: string; repo: string; branch: string; domain: string; withDb: boolean;
  port: number | null; tls: boolean | null; status: 'running' | 'success' | 'failed'; createdBy: string; createdAt: string; finishedAt: string | null;
}

export interface SshRule { cidr: string; description: string | null; grantId: number | null; expiresAt: string | null; temporary: boolean }
export interface SecurityGroupView { groupId: string; name: string; managedTag: boolean; rules: SshRule[]; prefixLists: { id: string; description: string | null }[]; openToWorld: boolean }
export interface SshGrant { id: number; kind: 'ip' | 'key'; route: 'direct' | 'ssm' | null; keyUser: string | null; keyFingerprint: string | null; keyFrom: string | null; keyAdded: boolean; groupId: string | null; cidr: string | null; reason: string | null; grantedBy: string; grantedAt: string; expiresAt: string; revokedAt: string | null; revokedBy: string | null; error: string | null }
export interface SshAccessView { groups: SecurityGroupView[]; target: string | null; grants: SshGrant[]; simulated: boolean; yourIp: string | null; hours: number[]; host: string | null; awsInstanceId: string; region: string; hostKeys: { type: string; fingerprint: string }[] }
export interface MyKey { id: number; name: string; fingerprint: string; type: string; createdAt: string; lastUsedAt: string | null }
export interface LaptopResult { grant: SshGrant; ipGrant: SshGrant | null; permanent: boolean; ipAlreadyAllowed: boolean; host: string | null; user: string; awsInstanceId: string; region: string; name: string; hostKeys: { type: string; fingerprint: string }[]; simulated: boolean }
export interface AuthorizedKey { type: string; bits: number | null; fingerprint: string | null; comment: string; options: boolean; blocked: boolean; expires?: number | null; from?: string | null; error?: string }
export interface SecuritySnapshot {
  at: number;
  os: { name: string | null; id: string | null; version: string | null; release: string | null; kernel: string };
  updates: {
    kind: 'release' | 'advisories' | null; current: string | null; currentDate: string | null; newer: { version: string; date: string | null }[];
    advisories: { id: string; severity: string; package: string }[]; advisoryCount: number; severities: Record<string, number>;
    command: string | null; error: string | null; rebootRequired: boolean | null; newestKernel: string | null; kernelPending: boolean;
  };
  sshd: Record<string, string>;
  users: { user: string; uid: number; home: string; keys: AuthorizedKey[]; manageable: boolean }[];
  logins: {
    accepted: { at: number; user: string; ip: string; method: string; keyType: string | null; fingerprint: string | null }[]; acceptedTotal: number;
    failed: { ip: string; count: number; count24h: number; last: number; users: string[] }[]; failedTotal: number; failed24h: number; failedIps: number; journal: boolean;
  };
  sessions: { user: string; tty: string; since: string; from: string | null }[];
}
export interface TerminalSession { id: number; username: string; ip: string | null; simulated: boolean; startedAt: string; endedAt: string | null; endReason: string | null }
export interface SecurityView { at: string | null; snapshot: SecuritySnapshot | null; terminalSessions: TerminalSession[]; activeTerminals: { username: string; startedAt: string }[] }

export interface FailedDeploy { instanceId: number; instance: string; project: string; status: string; at: string; actor: string; toSha: string; fromSha: string; trigger: string | null; runUrl: string | null; attempts: number; appExists: boolean }
export interface FailedCreation { id: number; instanceId: number; instance: string; project: string; repo: string; branch: string; domain: string; createdBy: string; createdAt: string; deploymentId: number | null; error: string | null; step: string | null }

export interface AwsConnection { region: string; roleArn: string | null; accountId: string | null; status: 'pending' | 'connected' | 'error' | 'disconnected'; error: string | null; connectedBy: string | null; connectedAt: string | null; externalId?: string }
export interface AwsConnectionView { connection: AwsConnection; principal?: string | null; quickCreateUrl: string | null; cloudFormationUrl: string; regions: [string, string][] }
export interface AwsServer { id: string; name: string | null; state: string; type: string; az: string; publicIp: string | null; platform: string; managedTag: boolean; instanceProfile: string | null; ssmOnline: boolean; linux: boolean; added: boolean }

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
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
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error || `Request failed (${res.status})`, (data as { code?: string }).code);
  return data as T;
}

export const api = {
  site: () => call<SiteConfig>('GET', '/api/account/config'),
  signup: (b: { name: string; email: string; password: string; workspace: string }) => call<{ ok: true; workspace: { id: number; name: string } }>('POST', '/api/account/signup', b),
  verifyEmail: (token: string) => call<{ ok: true }>('POST', '/api/account/verify', { token }),
  resendVerification: () => call<{ ok: true }>('POST', '/api/account/resend-verification'),
  forgotPassword: (email: string) => call<{ ok: true }>('POST', '/api/account/forgot', { email }),
  resetOwnPassword: (token: string, password: string) => call<{ ok: true }>('POST', '/api/account/reset', { token, password }),
  inviteInfo: (token: string) => call<{ invite: { email: string; role: Role; workspace: string; hasAccount: boolean } }>('GET', `/api/account/invites/${encodeURIComponent(token)}`).then((r) => r.invite),
  acceptInvite: (token: string, b: { name?: string; password?: string }) => call<{ ok: true; workspaceId: number }>('POST', `/api/account/invites/${encodeURIComponent(token)}/accept`, b),
  workspaces: () => call<{ workspaces: Workspace[]; current: number | null }>('GET', '/api/workspaces'),
  createWorkspace: (name: string) => call<{ workspace: Workspace }>('POST', '/api/workspaces', { name }),
  switchWorkspace: (id: number) => call<{ ok: true }>('POST', '/api/workspaces/switch', { id }),
  renameWorkspace: (name: string) => call<{ ok: true; name: string }>('PATCH', '/api/workspaces/current', { name }),
  team: () => call<{ members: TeamMember[]; invites: TeamInvite[] }>('GET', '/api/team'),
  invite: (email: string, role: Role) => call<{ ok: true }>('POST', '/api/team/invites', { email, role }),
  cancelInvite: (id: number) => call<{ ok: true }>('DELETE', `/api/team/invites/${id}`),
  setMemberRole: (userId: number, role: Role) => call<{ ok: true }>('PATCH', `/api/team/members/${userId}`, { role }),
  removeMember: (userId: number) => call<{ ok: true }>('DELETE', `/api/team/members/${userId}`),
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
    call<{ instance: Instance; samples: Sample[]; dbSeries: Record<string, DbPoint[]>; powerDryRun: boolean }>('GET', `/api/instances/${id}${refresh ? '?refresh=1' : ''}`),
  power: (id: number, action: 'start' | 'reboot' | 'stop' | 'terminate', b: { confirm?: string; reason?: string }) =>
    call<{ ok: boolean; message: string; state: string | null; dryRun: boolean }>('POST', `/api/instances/${id}/power`, { action, ...b }),
  addInstance: (b: { awsInstanceId: string; region: string; name: string; environment: string }) =>
    call<{ instance: Instance }>('POST', '/api/instances', b).then((r) => r.instance),
  updateInstance: (id: number, b: { name?: string; environment?: string }) =>
    call<{ instance: Instance }>('PATCH', `/api/instances/${id}`, b).then((r) => r.instance),
  removeInstance: (id: number) => call('DELETE', `/api/instances/${id}`),
  appView: (id: number, project: string) => call<AppView>('GET', `/api/instances/${id}/apps/${encodeURIComponent(project)}`),
  awsConnection: () => call<AwsConnectionView>('GET', '/api/aws-connection'),
  awsRegion: (region: string) => call<{ connection: AwsConnection }>('POST', '/api/aws-connection/region', { region }),
  awsVerify: (roleArn: string) => call<{ connection: AwsConnection }>('POST', '/api/aws-connection/verify', { roleArn }),
  awsDisconnect: () => call<{ ok: true; note: string }>('POST', '/api/aws-connection/disconnect'),
  awsServers: () => call<{ region: string; servers: AwsServer[] }>('GET', '/api/aws-connection/servers'),
  awsAddServer: (b: { awsInstanceId: string; name?: string; environment: string }) => call<{ instance: { id: number; name: string }; steps: string[]; note: string | null }>('POST', '/api/aws-connection/servers', b),
  failures: () => call<{ deploys: FailedDeploy[]; creations: FailedCreation[] }>('GET', '/api/failures'),
  dismissFailure: (b: { kind: 'deploy'; instanceId: number; project: string; at: string; note?: string } | { kind: 'create'; creationId: number; note?: string }) =>
    call<{ ok: true }>('POST', '/api/failures/dismiss', b),
  startDeployment: (id: number, project: string, action: 'deploy' | 'rollback', ref: string, override?: string) =>
    call<{ deployment: Deployment }>('POST', `/api/instances/${id}/apps/${encodeURIComponent(project)}/${action}`, override === undefined ? { ref } : { ref, override }).then((r) => r.deployment),
  approveDeployment: (id: number) => call<{ deployment: Deployment }>('POST', `/api/deployments/${id}/approve`).then((r) => r.deployment),
  rejectDeployment: (id: number, reason: string) => call<{ deployment: Deployment }>('POST', `/api/deployments/${id}/reject`, { reason }).then((r) => r.deployment),
  pendingDeployments: () => call<{ deployments: Deployment[] }>('GET', '/api/deployments?status=pending').then((r) => r.deployments),
  policy: () => call<{ policy: DeployPolicy; frozenNow: Record<EnvName, PolicyStatus['freeze']> }>('GET', '/api/policy'),
  savePolicy: (p: Partial<DeployPolicy>) => call<{ policy: DeployPolicy; frozenNow: Record<EnvName, PolicyStatus['freeze']> }>('PUT', '/api/policy', p),
  deployment: (id: number) => call<{ deployment: Deployment }>('GET', `/api/deployments/${id}`).then((r) => r.deployment),
  appDetail: (id: number, project: string, fetch = false) =>
    call<{ detail: AppDetailData; dbSeries: DbPoint[]; fetchedAt: string }>('GET', `/api/instances/${id}/apps/${encodeURIComponent(project)}/detail${fetch ? '?fetch=1' : ''}`),
  appLogs: (id: number, project: string, o: { lines: number; level: string; since: string; q: string }) =>
    call<LogsResult>('GET', `/api/instances/${id}/apps/${encodeURIComponent(project)}/logs?${new URLSearchParams({ lines: String(o.lines), level: o.level, since: o.since, q: o.q })}`),
  alerts: (state: 'open' | 'all' = 'all') => call<{ alerts: Alert[]; counts: AlertCounts }>('GET', `/api/alerts?state=${state}&limit=100`),
  ackAlert: (id: number) => call('POST', `/api/alerts/${id}/ack`),
  alertSettings: () => call<{ settings: AlertSettings }>('GET', '/api/alerts/settings').then((r) => r.settings),
  saveAlertSettings: (b: Partial<AlertSettings>) => call<{ settings: AlertSettings }>('PUT', '/api/alerts/settings', b).then((r) => r.settings),
  testAlerts: () => call<{ results: { channel: string; ok: boolean; error?: string }[] }>('POST', '/api/alerts/test').then((r) => r.results),
  uptime: () => call<{ apps: UptimeApp[] }>('GET', '/api/uptime').then((r) => r.apps),
  appUptime: (instanceId: number, project: string) =>
    call<{ summary: UptimeApp; series: UptimePoint[]; incidents: Alert[] }>('GET', `/api/uptime/${instanceId}/${encodeURIComponent(project)}`),
  backups: (refresh = false) => call<{ instances: InstanceBackups[]; downloads: boolean }>('GET', `/api/backups${refresh ? '?refresh=1' : ''}`),
  runBackup: (instanceId: number) => call<{ seconds: number }>('POST', `/api/backups/${instanceId}/run`),
  verifyBackup: (instanceId: number, db: string, file: string) =>
    call<{ verification: BackupVerification }>('POST', `/api/backups/${instanceId}/verify`, { db, file }).then((r) => r.verification),
  downloadBackup: (instanceId: number, db: string, file: string) =>
    call<{ url: string; expiresAt: string; bytes: number; sha256: string }>('POST', `/api/backups/${instanceId}/download`, { db, file }),
  secrets: (instanceId: number) => call<unknown>('GET', `/api/instances/${instanceId}/secrets`),
  rotateSecret: (instanceId: number, kind: 'db-password' | 'jwt', target: string, confirm: string) =>
    call<{ ok: boolean; updated: string[]; restarted: string[]; dryRun?: boolean }>('POST', `/api/instances/${instanceId}/secrets/rotate`, { kind, target, confirm }),
  updateSecret: (instanceId: number, service: string, key: string, value: string) =>
    call<{ ok: boolean; name: string; dryRun: boolean }>('PUT', `/api/instances/${instanceId}/secrets/value`, { service, key, value }),
  schedule: (id: number) => call<{ schedules: Schedule[] }>('GET', `/api/instances/${id}/schedule`).then((r) => r.schedules),
  editSchedule: (id: number, name: string, b: { time?: string; days?: number[]; enabled?: boolean }) =>
    call<{ schedules: Schedule[] }>('PUT', `/api/instances/${id}/schedule/${encodeURIComponent(name)}`, b),
  skipStop: (id: number, name: string) => call<{ schedules: Schedule[]; until: string }>('POST', `/api/instances/${id}/schedule/${encodeURIComponent(name)}/skip`),
  costs: () => call<{ summary: CostSummary; settings: CostSettings }>('GET', '/api/costs'),
  refreshCosts: () => call<{ summary: CostSummary; settings: CostSettings; fetched: boolean }>('POST', '/api/costs/refresh'),
  saveCostSettings: (b: { monthlyBudget?: string | number | null; zarRate?: string | number | null; currency?: 'USD' | 'ZAR' }) => call<{ settings: CostSettings }>('PUT', '/api/costs/settings', b),
  github: () => call<GithubStatus>('GET', '/api/github'),
  githubManifest: (org?: string) => call<{ action: string; manifest: object }>('POST', '/api/github/manifest', org ? { org } : {}),
  githubExchange: (code: string, state: string) => call<{ connected: boolean; installUrl: string }>('POST', '/api/github/exchange', { code, state }),
  githubDisconnect: () => call<{ ok: boolean; deleteAppUrl: string | null }>('DELETE', '/api/github'),
  githubRepos: (refresh = false) => call<{ repos: GithubRepo[] }>('GET', `/api/github/repos${refresh ? '?refresh=1' : ''}`).then((r) => r.repos),
  githubBranches: (repo: string) => call<{ branches: string[] }>('GET', `/api/github/branches?repo=${encodeURIComponent(repo)}`).then((r) => r.branches),
  linkRepo: (id: number, project: string, b: { repo: string; branch: string; autoDeploy: boolean }) => call('PUT', `/api/instances/${id}/apps/${encodeURIComponent(project)}/repo`, b),
  unlinkRepo: (id: number, project: string) => call('DELETE', `/api/instances/${id}/apps/${encodeURIComponent(project)}/repo`),
  env: (id: number, project: string) => call<{ service: string; dbRole: string | null; vars: EnvVar[]; dryRun: boolean }>('GET', `/api/instances/${id}/apps/${encodeURIComponent(project)}/env`),
  revealEnv: (id: number, project: string, key: string) => call<{ key: string; value: string }>('POST', `/api/instances/${id}/apps/${encodeURIComponent(project)}/env/reveal`, { key }).then((r) => r.value),
  setEnv: (id: number, project: string, key: string, value: string) => call<{ verb: string; dryRun: boolean }>('PUT', `/api/instances/${id}/apps/${encodeURIComponent(project)}/env`, { key, value }),
  removeEnv: (id: number, project: string, key: string) => call<{ verb: string; dryRun: boolean }>('DELETE', `/api/instances/${id}/apps/${encodeURIComponent(project)}/env/${encodeURIComponent(key)}`),
  detectRepo: (repo: string, branch: string, subdir: string) =>
    call<Detection>('GET', `/api/github/detect?${new URLSearchParams({ repo, branch, subdir })}`),
  newAppCheck: (id: number, project: string, subdomain: string) =>
    call<NewAppCheck>('GET', `/api/instances/${id}/new-app/check?${new URLSearchParams({ project, subdomain })}`),
  security: (id: number) => call<SecurityView>('GET', `/api/instances/${id}/security`),
  refreshSecurity: (id: number) => call<{ at: string; snapshot: SecuritySnapshot }>('POST', `/api/instances/${id}/security/refresh`),
  sshAccess: (id: number) => call<SshAccessView>('GET', `/api/instances/${id}/ssh-access`),
  grantSsh: (id: number, b: { ip?: string; hours: number; reason?: string }) => call<{ grant: SshGrant; simulated: boolean }>('POST', `/api/instances/${id}/ssh-access`, b),
  revokeSsh: (id: number, grantId: number) => call<{ grant: SshGrant }>('DELETE', `/api/instances/${id}/ssh-access/${grantId}`),
  myKeys: () => call<{ keys: MyKey[] }>('GET', '/api/ssh-keys').then((r) => r.keys),
  saveMyKey: (b: { name?: string; key: string }) => call<{ key: MyKey }>('POST', '/api/ssh-keys', b).then((r) => r.key),
  deleteMyKey: (keyId: number) => call<{ ok: true }>('DELETE', `/api/ssh-keys/${keyId}`),
  laptopAccess: (id: number, b: { keyId: number; route: 'direct' | 'ssm'; hours: number; ip?: string; reason?: string }) => call<LaptopResult>('POST', `/api/instances/${id}/laptop-access`, b),
  sshKey: (id: number, b: { action: 'add'; user: string; key: string } | { action: 'remove'; user: string; fingerprint: string }) =>
    call<{ ok: true; fingerprint: string | null; keys?: number; dryRun?: boolean }>('POST', `/api/instances/${id}/ssh-keys`, b),
  newAppHistory: (id: number) => call<{ creations: NewAppCreation[] }>('GET', `/api/instances/${id}/new-app`).then((r) => r.creations),
  createApp: (id: number, b: NewAppBody) => call<{ deployment: Deployment }>('POST', `/api/instances/${id}/new-app`, b).then((r) => r.deployment),
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
