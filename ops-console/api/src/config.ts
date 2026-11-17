// Runtime configuration (all from environment; secrets come from SSM via app-secrets@ops-console).
const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);
const bool = (v: string | undefined, d: boolean) => (v === undefined ? d : ['1', 'true', 'yes'].includes(v.toLowerCase()));

export const config = {
    port: num(process.env.PORT, 9200),
    host: process.env.HOST || '127.0.0.1',
    databaseUrl: process.env.DATABASE_URL || 'postgresql://opsconsole@127.0.0.1:5432/opsconsole',
    /** Origins allowed to make state-changing requests (CSRF check). Comma-separated. */
    allowedOrigins: (process.env.ALLOWED_ORIGINS || 'https://ops.glenify.studio')
        .split(',').map((s) => s.trim()).filter(Boolean),
    cookieName: 'ops_session',
    cookieSecure: bool(process.env.COOKIE_SECURE, true),
    sessionHours: num(process.env.SESSION_HOURS, 12),
    demoEnabled: bool(process.env.DEMO_ENABLED, true),
    demoSessionMinutes: num(process.env.DEMO_SESSION_MINUTES, 30),
    /** Lock an account after this many consecutive failed logins… */
    maxFailedLogins: num(process.env.MAX_FAILED_LOGINS, 5),
    /** …for this long. */
    lockMinutes: num(process.env.LOCK_MINUTES, 15),
    /** Per-IP login attempts per window (in-memory). */
    loginRateLimit: num(process.env.LOGIN_RATE_LIMIT, 10),
    loginRateWindowMs: num(process.env.LOGIN_RATE_WINDOW_MS, 15 * 60 * 1000),
    webDist: process.env.WEB_DIST || '../web/dist',
    /** Trust X-Forwarded-For from nginx on localhost. */
    trustProxy: bool(process.env.TRUST_PROXY, true),
    /** Local test mode only: accept any http://localhost|127.0.0.1|[::1]:<port> origin (never set in production). */
    allowLoopbackOrigins: bool(process.env.OPS_ALLOW_LOOPBACK_ORIGINS, false),
    /** Private S3 bucket for backup downloads (SSM /apps/ops-console/TRANSFER_BUCKET); '' disables downloads. */
    transferBucket: process.env.TRANSFER_BUCKET || '',
    transferRegion: process.env.TRANSFER_REGION || 'af-south-1',
    /** Multi-customer (SaaS) mode: sign-up, workspaces, no access to the host's own AWS account. Off = the single-team console. */
    multiTenant: bool(process.env.OPS_MULTI_TENANT, false),
    /** Product name shown on the landing page and in emails (placeholder until it is decided). */
    productName: process.env.PRODUCT_NAME || 'Ops Console',
    /** Public address of this console (links in emails). */
    publicUrl: process.env.PUBLIC_URL || 'https://ops.glenify.studio',
    /** Free trial for new workspaces. */
    trialDays: num(process.env.TRIAL_DAYS, 14),
    /** AWS identity customer roles must trust (default: whatever this console runs as, e.g. its instance role). */
    consolePrincipalArn: process.env.CONSOLE_PRINCIPAL_ARN || '',
    /** Public S3 URL of the Connect-AWS CloudFormation template (enables the one-click "quick create" link). */
    connectTemplateUrl: process.env.CONNECT_TEMPLATE_URL || '',
    /** Server release bundle for OpsConsole-PrepareServer (from infra/saas/publish-template.sh). */
    serverBundleUrl: process.env.SERVER_BUNDLE_URL || '',
    /** Multi-customer mode: emails of the people who run the platform (they set up the shared GitHub App). */
    platformAdmins: (process.env.PLATFORM_ADMINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    serverBundleSha256: process.env.SERVER_BUNDLE_SHA256 || '',
};
