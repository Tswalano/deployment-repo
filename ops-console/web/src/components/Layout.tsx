import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api, ROLE_INFO } from '../api';
import { useAuth } from '../auth';

type Tab = { to: string; label: string; end?: boolean; admin?: boolean; deployer?: boolean; mobile?: boolean; group?: 'Operations' | 'Administration'; icon: JSX.Element };

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]" aria-hidden>
    <path d={d} />
  </svg>
);
const TABS: Tab[] = [
  { to: '/', label: 'Overview', end: true, mobile: true, icon: <Icon d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" /> },
  { to: '/instances', label: 'Instances', mobile: true, icon: <Icon d="M4 6h16M4 12h16M4 18h16M7 6v0M7 12v0M7 18v0" /> },
  { to: '/activity', label: 'Activity', mobile: true, icon: <Icon d="M3 12h4l3-8 4 16 3-8h4" /> },
  { to: '/alerts', label: 'Alerts', mobile: true, icon: <Icon d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" /> },
  { to: '/backups', label: 'Backups', group: 'Operations', icon: <Icon d="M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /> },
  { to: '/costs', label: 'Costs', group: 'Operations', deployer: true, icon: <Icon d="M12 2v20M17 6.5c0-1.9-2.2-3.5-5-3.5s-5 1.6-5 3.5 2.2 3 5 3.5 5 1.6 5 3.5-2.2 3.5-5 3.5-5-1.6-5-3.5" /> },
  { to: '/secrets', label: 'Secrets', group: 'Operations', deployer: true, icon: <Icon d="M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5z" /> },
  { to: '/users', label: 'Users', group: 'Administration', admin: true, icon: <Icon d="M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 19v-1a4 4 0 0 0-3-3.9M16 2.1a4 4 0 0 1 0 7.8" /> },
  { to: '/audit', label: 'Audit log', group: 'Administration', admin: true, icon: <Icon d="M9 12h6M9 16h6M9 8h2M6 3h9l5 5v13H6z" /> },
  { to: '/settings', label: 'Settings', group: 'Administration', admin: true, icon: <Icon d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /> },
];

function UserMenu({ pages }: { pages: Tab[] }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, []);
  if (!user) return null;
  const initials = (user.displayName || user.username).split(/[\s._-]+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}
              aria-label="Menu" className="flex items-center gap-1.5 rounded-full border border-ink-600 py-0.5 pl-0.5 pr-2 text-slate-400 transition hover:border-ink-500 hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/70">
        <span className="grid h-7 w-7 place-items-center rounded-full bg-gradient-to-br from-indigo-500/40 to-sky-500/30 text-xs font-semibold text-white">{initials}</span>
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-10 z-30 w-60 overflow-hidden rounded-xl border border-ink-600 bg-ink-850 shadow-2xl shadow-black/50">
          <div className="border-b border-ink-700 px-4 py-3">
            <div className="truncate text-sm font-medium text-slate-100" title={user.username}>{user.displayName || user.username}</div>
            <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">@{user.username} <span className={ROLE_INFO[user.role].badge}>{ROLE_INFO[user.role].label}</span></div>
          </div>
          {(['Operations', 'Administration'] as const).map((g) => {
            const items = pages.filter((t) => t.group === g);
            return items.length ? (
              <div key={g} className="border-b border-ink-700 py-1.5">
                <div className="px-4 pb-1 pt-1.5 text-2xs font-semibold uppercase tracking-wider text-slate-500">{g}</div>
                {items.map((t) => (
                  <NavLink key={t.to} to={t.to} role="menuitem" onClick={() => setOpen(false)}
                           className={({ isActive }) => `flex items-center gap-2.5 px-4 py-2 text-sm ${isActive ? 'bg-ink-800 text-white' : 'text-slate-300 hover:bg-ink-800'}`}>
                    <span className="text-slate-500">{t.icon}</span>{t.label}
                  </NavLink>
                ))}
              </div>
            ) : null;
          })}
          {!user.isDemo && (
            <button role="menuitem" className="block w-full px-4 py-2.5 text-left text-sm text-slate-300 hover:bg-ink-800" onClick={() => { setOpen(false); navigate('/account'); }}>
              Account & password
            </button>
          )}
          <button role="menuitem" className="block w-full px-4 py-2.5 text-left text-sm text-slate-300 hover:bg-ink-800"
                  onClick={async () => { await logout(); navigate('/login'); }}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export function Layout() {
  const { user } = useAuth();
  const { pathname } = useLocation();
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  const [alerts, setAlerts] = useState({ open: 0, critical: 0 });
  const [localMode, setLocalMode] = useState(false);
  useEffect(() => { fetch('/api/health').then((r) => r.json()).then((h) => setLocalMode(h.mode === 'local-dry-run')).catch(() => undefined); }, []);
  useEffect(() => {
    if (!user) return;
    const load = () => api.alerts('open').then((r) => setAlerts(r.counts)).catch(() => undefined);
    void load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 60_000);
    return () => clearInterval(t);
  }, [user, pathname]);
  if (!user) return null;
  const tabs = TABS.filter((t) => (!t.admin || user.role === 'admin') && (!t.deployer || ((user.role === 'admin' || user.role === 'deployer') && !user.isDemo)));
  const badge = (t: Tab) => t.to === '/alerts' && alerts.open > 0 && (
    <span className={`num ml-0.5 rounded-full px-1.5 text-2xs font-semibold ${alerts.critical ? 'bg-rose-500 text-white' : 'bg-amber-400 text-ink-950'}`}>{alerts.open}</span>
  );

  return (
    <div className="min-h-screen pb-20 md:pb-0">
      {localMode && (
        <div className="border-b border-fuchsia-500/30 bg-fuchsia-500/10 px-4 py-2 text-center text-xs text-fuchsia-200">
          Local test mode: live data from AWS, but deploys and “Back up now” are simulated and notifications are only logged.
        </div>
      )}
      {user.isDemo && (
        <div className="border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-center text-xs text-amber-200">
          Read-only demo — you can look at everything; nothing you do changes anything.
        </div>
      )}
      <header className="sticky top-0 z-20 border-b border-ink-700 bg-ink-950/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-3 px-4 sm:px-6">
          <NavLink to="/" className="flex items-center gap-2.5">
            <span className="grid h-7 w-7 place-items-center rounded-lg border border-indigo-400/40 bg-indigo-500/15 text-indigo-300">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M12 3 3 20h18L12 3z" /></svg>
            </span>
            <span className="text-sm font-semibold tracking-tight text-slate-100">Ops Console</span>
          </NavLink>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-200 sm:inline-flex">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" /> Production
            </span>
            <UserMenu pages={tabs} />
          </div>
        </div>
        <nav aria-label="Main" className="mx-auto hidden max-w-[1400px] gap-1 px-4 sm:px-6 md:flex">
          {tabs.filter((t) => !t.group).map((t) => (
            <NavLink key={t.to} to={t.to} end={t.end}
                     className={({ isActive }) => `-mb-px flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm transition-colors ${isActive
                       ? 'border-indigo-400 font-medium text-slate-100'
                       : 'border-transparent text-slate-400 hover:border-ink-500 hover:text-slate-200'}`}>
              {t.icon}{t.label}{badge(t)}
            </NavLink>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">
        <Outlet />
      </main>

      {/* Phones: only the views that make sense on a small screen */}
      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-4 border-t border-ink-700 bg-ink-950/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        {TABS.filter((t) => t.mobile).map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end}
                   className={({ isActive }) => `relative flex flex-col items-center gap-1 py-2.5 text-2xs font-medium ${isActive ? 'text-indigo-300' : 'text-slate-500'}`}>
            {t.icon}{t.label}
            {t.to === '/alerts' && alerts.open > 0 && <span className={`absolute right-[calc(50%-1.1rem)] top-1.5 h-2 w-2 rounded-full ${alerts.critical ? 'bg-rose-500' : 'bg-amber-400'}`} />}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
