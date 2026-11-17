/** Plans shown on the landing page (billing itself arrives in Phase 12c; prices in Rand per month). */
export const PLANS = [
  {
    id: 'starter', name: 'Starter', price: 199,
    blurb: 'One server, run properly.',
    features: ['1 server', '3 apps', '2 team members', 'Deploy from GitHub, health checks, alerts', 'Backups with restore tests', 'Browser terminal and SSH access'],
  },
  {
    id: 'pro', name: 'Pro', price: 599, highlight: true,
    blurb: 'For teams running several apps.',
    features: ['5 servers', '20 apps', '10 team members', 'Everything in Starter', 'Deploy approvals and freeze windows', 'Cost tracking and schedules'],
  },
] as const;
