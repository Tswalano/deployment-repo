import { ROLE_INFO } from '../api';
import { useAuth } from '../auth';

const ROADMAP = [
  { phase: 'Phase 1', title: 'Accounts & access', done: true, text: 'Sign-in, roles (admin, deployer, viewer), user management, audit log, read-only demo.' },
  { phase: 'Phase 2', title: 'Instances', done: false, text: 'Add EC2 instances in Settings; health, memory, disk and services per instance via AWS SSM.' },
  { phase: 'Phase 3', title: 'Apps & deploys', done: false, text: 'App pages (health, logs, databases, commits) and one-click deploys with live progress.' },
  { phase: 'Phase 4', title: 'Go live', done: false, text: 'Public at ops.glenify.studio with the demo on the portfolio.' },
];

export function Overview() {
  const { user } = useAuth();
  if (!user) return null;
  const role = ROLE_INFO[user.role];
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Welcome, {user.displayName || user.username}</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          You're signed in as <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${role.badge}`}>{role.label}</span>{' '}
          — {role.description.toLowerCase()}.
        </p>
      </div>

      <section className="card">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">What's coming</h2>
        <ol className="mt-4 grid gap-3 sm:grid-cols-2">
          {ROADMAP.map((r) => (
            <li key={r.phase} className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{r.phase}</span>
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${r.done
                  ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                  : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'}`}>{r.done ? 'Live' : 'Planned'}</span>
              </div>
              <div className="mt-1 font-medium">{r.title}</div>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{r.text}</p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
