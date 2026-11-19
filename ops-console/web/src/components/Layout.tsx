import { ReactNode, useEffect, useRef, useState } from 'react';
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { NoWorkspace } from '../pages/Team';
import { Onboarding } from '../pages/Onboarding';
import { Footer } from './Footer';
import { useTheme } from '../theme';
import { api, ROLE_INFO, Workspace } from '../api';
import { useAuth } from '../auth';
import { useDialog } from './Dialog';
import { AskPanel } from './AskPanel';
import { navIcon, smallIcon } from './icons';
import { Activity, Bell, ChevronDown, CreditCard, DatabaseBackup, Gauge, LayoutDashboard, LogOut, Monitor, Moon, Plus, ScrollText, Server, Settings, Shield,
  ShieldCheck, Sparkles, Sun, UserRound, Users, Wallet, Wrench } from 'lucide-react';

/** Pages reachable while a new workspace is being set up (multi-customer mode). */
const SETUP_PATHS = ['/', '/team', '/account', '/settings', '/github/callback', '/billing', '/billing/return'];

type Tab = { to: string; label: string; end?: boolean; admin?: boolean; deployer?: boolean; noDemo?: boolean; mobile?: boolean; group?: 'Monitoring' | 'Operations' | 'Administration'; icon: JSX.Element };

const TABS: Tab[] = [
  { to: '/', label: 'Overview', end: true, mobile: true, icon: navIcon(LayoutDashboard) },
  { to: '/instances', label: 'Instances', mobile: true, icon: navIcon(Server) },
  { to: '/ai', label: 'AI Console', noDemo: true, icon: navIcon(Sparkles) },
  { to: '/alerts', label: 'Alerts', group: 'Monitoring', icon: navIcon(Bell) },
  { to: '/activity', label: 'Activity', group: 'Monitoring', icon: navIcon(Activity) },
  { to: '/backups', label: 'Backups', group: 'Operations', icon: navIcon(DatabaseBackup) },
  { to: '/costs', label: 'Costs', group: 'Operations', deployer: true, icon: navIcon(Wallet) },
  { to: '/users', label: 'Users', group: 'Administration', admin: true, icon: navIcon(Users) },
  { to: '/audit', label: 'Audit log', group: 'Administration', admin: true, icon: navIcon(ScrollText) },
  { to: '/settings', label: 'Settings', group: 'Administration', admin: true, icon: navIcon(Settings) },
];
const GROUP_ICON = { Monitoring: Gauge, Operations: Wrench, Administration: ShieldCheck } as const;

function UserMenu({ pages, workspaces = [], onSwitched }: { pages: Tab[]; workspaces?: Workspace[]; onSwitched?: () => Promise<void> }) {
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
  const [theme, setTheme] = useTheme();
  const dialog = useDialog();
  if (!user) return null;
  const initials = (user.displayName || user.username).split(/[\s._-]+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}
              aria-label="Menu" className="flex items-center gap-1.5 rounded-full border border-ink-600 py-0.5 pl-0.5 pr-2 text-slate-400 transition hover:border-ink-500 hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/70">
        <span className="grid h-7 w-7 place-items-center rounded-full bg-indigo-500/30 text-xs font-semibold text-indigo-100">{initials}</span>
        <ChevronDown className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-10 z-30 w-60 overflow-hidden rounded-xl border border-ink-600 bg-ink-850 shadow-2xl shadow-black/50">
          <div className="border-b border-ink-700 px-4 py-3">
            <div className="truncate text-sm font-medium text-slate-100" title={user.username}>{user.displayName || user.username}</div>
            <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">@{user.username} <span className={ROLE_INFO[user.role].badge}>{ROLE_INFO[user.role].label}</span></div>
          </div>
          {workspaces.length > 0 && (
            <div className="border-b border-ink-700 py-1.5">
              <div className="px-4 pb-1 pt-1.5 text-2xs font-semibold uppercase tracking-wider text-slate-500">Workspaces</div>
              {workspaces.map((w) => (
                <button key={w.id} role="menuitem" className={`flex w-full items-center gap-2 px-4 py-2 text-left text-sm ${w.id === user.workspaceId ? 'text-slate-100' : 'text-slate-300 hover:bg-ink-800'}`}
                        disabled={w.id === user.workspaceId}
                        onClick={async () => { setOpen(false); await api.switchWorkspace(w.id); await onSwitched?.(); }}>
                  <span className={`h-1.5 w-1.5 rounded-full ${w.id === user.workspaceId ? 'bg-indigo-400' : 'bg-transparent'}`} />
                  <span className="min-w-0 flex-1 truncate">{w.name}</span><span className="text-2xs capitalize text-slate-500">{w.role}</span>
                </button>
              ))}
              <button role="menuitem" className="flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm text-slate-400 hover:bg-ink-800" onClick={async () => {
                setOpen(false);
                const name = await dialog.prompt({ title: 'New workspace', body: 'A separate workspace with its own servers, team and billing (it starts on a free trial).',
                  label: 'Workspace name', placeholder: 'e.g. Acme Ltd', minLength: 2, maxLength: 80, confirmLabel: 'Create workspace' });
                if (!name) return;
                try { await api.createWorkspace(name); await onSwitched?.(); }
                catch (e) { await dialog.alert({ title: "The workspace wasn't created", body: e instanceof Error ? e.message : 'Something went wrong.' }); }
              }}>{smallIcon(Plus, 'text-slate-500')}New workspace</button>
            </div>
          )}
          {user.platformAdmin && (
            <div className="border-b border-ink-700 py-1.5">
              <NavLink to="/platform" role="menuitem" onClick={() => setOpen(false)} className="flex items-center gap-2.5 px-4 py-2 text-sm text-slate-300 hover:bg-ink-800 hover:text-white">
                {smallIcon(Shield, 'text-slate-500')}
                Platform admin
              </NavLink>
            </div>
          )}
          <div className="border-b border-ink-700 px-4 py-3">
            <div className="mb-2 text-2xs font-semibold uppercase tracking-wider text-slate-500">Theme</div>
            <div className="grid grid-cols-3 gap-1 rounded-lg border border-ink-600 bg-ink-950 p-1" role="radiogroup" aria-label="Theme">
              {([['dark', 'Dark', Moon], ['light', 'Light', Sun], ['system', 'System', Monitor]] as const).map(([v, label, I]) => (
                <button key={v} role="radio" aria-checked={theme === v} onClick={() => setTheme(v)}
                        className={`flex flex-col items-center gap-1 rounded-md px-1 py-1.5 text-2xs ${theme === v ? 'bg-indigo-500/20 text-indigo-200' : 'text-slate-400 hover:bg-ink-800 hover:text-slate-200'}`}>
                  {smallIcon(I)}
                  {label}
                </button>
              ))}
            </div>
          </div>
          {(['Monitoring', 'Operations', 'Administration'] as const).map((g) => {
            const items = pages.filter((t) => t.group === g);
            return items.length ? (
              <div key={g} className="border-b border-ink-700 py-1.5 md:hidden">
                <div className="flex items-center gap-1.5 px-4 pb-1 pt-1.5 text-2xs font-semibold uppercase tracking-wider text-slate-500">{smallIcon(GROUP_ICON[g], 'h-3.5 w-3.5')}{g}</div>
                {items.map((t) => (
                  <NavLink key={t.to} to={t.to} role="menuitem" onClick={() => setOpen(false)}
                           className={({ isActive }) => `flex items-center gap-2.5 px-4 py-2 text-sm ${isActive ? 'bg-ink-800 text-slate-100' : 'text-slate-300 hover:bg-ink-800'}`}>
                    <span className="text-slate-500">{t.icon}</span>{t.label}
                  </NavLink>
                ))}
              </div>
            ) : null;
          })}
          {!user.isDemo && (
            <button role="menuitem" className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-slate-300 hover:bg-ink-800" onClick={() => { setOpen(false); navigate('/account'); }}>
              {smallIcon(UserRound, 'text-slate-500')}Account & password
            </button>
          )}
          <button role="menuitem" className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-slate-300 hover:bg-ink-800"
                  onClick={async () => { await logout(); navigate('/login'); }}>
            {smallIcon(LogOut, 'text-slate-500')}Sign out
          </button>
        </div>
      )}
    </div>
  );
}

/** Navbar dropdown for a group of pages (Operations, Administration). */
function NavGroup({ label, items, badge, itemBadge }: { label: keyof typeof GROUP_ICON; items: Tab[]; badge?: ReactNode; itemBadge?: (t: Tab) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  const active = items.some((t) => pathname === t.to || pathname.startsWith(`${t.to}/`));
  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, []);
  if (!items.length) return null;
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}
              className={`-mb-px flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm transition-colors ${active
                ? 'border-indigo-400 font-medium text-slate-100' : 'border-transparent text-slate-400 hover:border-ink-500 hover:text-slate-200'}`}>
        {navIcon(GROUP_ICON[label])}{label}{badge}
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} strokeWidth={2} aria-hidden />
      </button>
      {open && (
        <div role="menu" className="absolute left-0 top-full z-30 mt-1 w-56 overflow-hidden rounded-xl border border-ink-600 bg-ink-850 py-1.5 shadow-2xl shadow-black/50">
          {items.map((t) => (
            <NavLink key={t.to} to={t.to} role="menuitem"
                     className={({ isActive }) => `flex items-center gap-2.5 px-4 py-2 text-sm ${isActive ? 'bg-ink-800 text-slate-100' : 'text-slate-300 hover:bg-ink-800 hover:text-white'}`}>
              <span className="text-slate-500">{t.icon}</span>{t.label}{itemBadge?.(t) && <span className="ml-auto">{itemBadge(t)}</span>}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

export function Layout() {
  const { user, site, refresh } = useAuth();
  const [wss, setWss] = useState<Workspace[]>([]);
  // "Ask Ops Console" (never in the demo)
  const [askOn, setAskOn] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [askSignal, setAskSignal] = useState(0);   // the header button also restores a minimised window
  // shown once the workspace has a provider key, and to admins (who can set one up from the panel)
  useEffect(() => { if (user && !user.isDemo) api.assistant().then((s) => setAskOn(s.enabled || !!s.canConfigure)).catch(() => setAskOn(false)); }, [user]);
  useEffect(() => {   // the AI Console's "Open the chat"
    const on = () => { setAskOpen(true); setAskSignal((n) => n + 1); };
    window.addEventListener('ops:open-ask', on);
    return () => window.removeEventListener('ops:open-ask', on);
  }, []);
  // proposals from AI waiting for this person's confirmation (badge on the AI Console link)
  const [waiting, setWaiting] = useState(0);
  useEffect(() => {
    if (!user || user.isDemo || (site.multiTenant && user.workspaceId == null)) return;
    const poll = () => api.actions(true).then((a) => setWaiting(a.length)).catch(() => undefined);
    void poll();
    const t = setInterval(poll, 30_000);
    window.addEventListener('ops:actions-changed', poll);
    return () => { clearInterval(t); window.removeEventListener('ops:actions-changed', poll); };
  }, [user, site.multiTenant]);
  const [resent, setResent] = useState(false);
  useEffect(() => { if (user && site.multiTenant && user.workspaceId != null) api.workspaces().then((r) => setWss(r.workspaces)).catch(() => undefined); }, [user, site.multiTenant]);
  // Setup mode (multi-customer): until the workspace has a server, show the onboarding screen without the app's
  // navigation; only Team, Account and Settings stay reachable. (Phase 12b: "AWS connected" instead of "has a server".)
  const [setupMode, setSetupMode] = useState<boolean | null>(null);
  useEffect(() => {
    if (!user || !site.multiTenant || user.workspaceId == null) { setSetupMode(false); return; }
    api.instances().then((l) => setSetupMode(l.length === 0)).catch(() => setSetupMode(false));
  }, [user, site.multiTenant]);
  const { pathname } = useLocation();
  const [bill, setBill] = useState<{ active: boolean; reason: string | null } | null>(null);
  useEffect(() => { if (user && site.multiTenant && user.workspaceId != null) api.billing().then((b) => setBill({ active: b.active, reason: b.reason })).catch(() => undefined); }, [user, site.multiTenant, pathname]);
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
  if (site.multiTenant && user.workspaceId == null) return <NoWorkspace />;
  if (site.multiTenant && setupMode === null) return null;
  const setup = !!setupMode;
  if (setup && !SETUP_PATHS.includes(pathname)) return <Navigate to="/" replace />;
  const current = wss.find((w) => w.id === user.workspaceId);
  const trialDays = current?.plan === 'trial' && current.trialEndsAt ? Math.max(0, Math.ceil((Date.parse(current.trialEndsAt) - Date.now()) / 86400e3)) : null;
  // with many customers the global Users page becomes the workspace's Team page (all members see it)
  const TABS_HERE = site.multiTenant
    ? [...TABS.map((t) => (t.to === '/users' ? { ...t, to: '/team', label: 'Team', admin: false } : t)),
       { to: '/billing', label: 'Billing', group: 'Administration' as const, admin: true, icon: navIcon(CreditCard) }]
    : TABS;
  const tabs = TABS_HERE.filter((t) => (!t.noDemo || !user.isDemo) && (!t.admin || user.role === 'admin') && (!t.deployer || ((user.role === 'admin' || user.role === 'deployer') && !user.isDemo)));
  const alertBadge = alerts.open > 0 ? (
    <span className={`num ml-0.5 rounded-full px-1.5 text-2xs font-semibold ${alerts.critical ? 'bg-rose-500 text-white' : 'bg-amber-400 text-ink-950'}`}
          title={`${alerts.open} open alert${alerts.open === 1 ? '' : 's'}`}>{alerts.open}</span>
  ) : null;
  const proposalBadge = waiting > 0 ? <span className="num ml-0.5 rounded-full bg-amber-400 px-1.5 text-2xs font-semibold text-ink-950" title={`${waiting} proposal${waiting === 1 ? '' : 's'} waiting for confirmation`}>{waiting}</span> : null;
  const badge = (t: Tab) => (t.to === '/alerts' ? alertBadge : t.to === '/ai' ? proposalBadge : null);
  const monitoringActive = pathname === '/alerts' || pathname === '/activity';

  return (
    <div className="min-h-screen pb-20 md:pb-0">
      {localMode && (
        <div className="border-b border-fuchsia-500/30 bg-fuchsia-500/10 px-4 py-2 text-center text-xs text-fuchsia-200">
          Local test mode: live data from AWS, but deploys and “Back up now” are simulated and notifications are only logged.
        </div>
      )}
      {bill && !bill.active && (
        <div className="border-b border-rose-500/30 bg-rose-500/10 px-4 py-2 text-center text-xs text-rose-200">
          Read-only: {bill.reason} Servers and apps keep running.{' '}
          {user.role === 'admin' && <NavLink to="/billing" className="underline underline-offset-2">Go to Billing</NavLink>}
        </div>
      )}
      {site.multiTenant && user.email && !user.emailVerified && (
        <div className="border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-center text-xs text-amber-200">
          Email confirmation pending: a link was sent to {user.email}.{' '}
          {resent ? 'Sent again.' : <button className="underline underline-offset-2" onClick={() => { void api.resendVerification().then(() => setResent(true)); }}>Send it again</button>}
        </div>
      )}
      {trialDays != null && !setup && (   /* during setup the onboarding page shows the trial itself */
        <div className="border-b border-indigo-400/20 bg-indigo-500/10 px-4 py-2 text-center text-xs text-indigo-200">
          Free trial: {trialDays === 0 ? 'ends today' : `${trialDays} day${trialDays === 1 ? '' : 's'} left`}. Nothing is charged during the trial. {user.role === 'admin' && <NavLink to="/billing" className="underline underline-offset-2">Choose a plan</NavLink>}
        </div>
      )}
      {user.isDemo && (
        <div className="border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-center text-xs text-amber-200">
          Read-only demo: everything is visible; nothing can be changed.{site.multiTenant && <> <a href="/signup" className="underline underline-offset-2" onClick={async (e) => { e.preventDefault(); await api.logout().catch(() => undefined); window.location.assign('/signup'); }}>Start a free trial</a></>}
        </div>
      )}
      <header className="sticky top-0 z-20 border-b border-ink-700 bg-ink-950/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-3 px-4 sm:px-6">
          <NavLink to="/" className="flex items-center gap-2.5">
            <span className="grid h-7 w-7 place-items-center rounded-lg border border-indigo-400/40 bg-indigo-500/15 text-indigo-300">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M12 3 3 20h18L12 3z" /></svg>
            </span>
            <span className="text-sm font-semibold tracking-tight text-slate-100">{site.productName}</span>
            {site.multiTenant && current && <span className="hidden max-w-[12rem] truncate rounded-md border border-ink-600 px-2 py-0.5 text-xs text-slate-400 sm:inline" title="Current workspace">{current.name}</span>}
          </NavLink>
          <div className="ml-auto flex items-center gap-2">
            {setup && <NavLink to="/team" className={({ isActive }) => `hidden items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm sm:flex ${isActive ? 'text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}>{smallIcon(Users)}Team</NavLink>}
            {setup && user.role === 'admin' && <NavLink to="/billing" className={({ isActive }) => `hidden items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm sm:flex ${isActive ? 'text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}>{smallIcon(CreditCard)}Billing</NavLink>}
            <UserMenu pages={tabs} workspaces={site.multiTenant ? wss : []} onSwitched={async () => { await refresh(); window.location.assign('/'); }} />
          </div>
        </div>
        {!setup && <nav aria-label="Main" className="mx-auto hidden max-w-[1400px] gap-1 px-4 sm:px-6 md:flex">
          {tabs.filter((t) => !t.group).map((t) => (
            <NavLink key={t.to} to={t.to} end={t.end}
                     className={({ isActive }) => `-mb-px flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm transition-colors ${isActive
                       ? 'border-indigo-400 font-medium text-slate-100'
                       : 'border-transparent text-slate-400 hover:border-ink-500 hover:text-slate-200'}`}>
              {t.icon}{t.label}{badge(t)}
            </NavLink>
          ))}
          <NavGroup label="Monitoring" items={tabs.filter((t) => t.group === 'Monitoring')} badge={alertBadge} itemBadge={badge} />
          <NavGroup label="Operations" items={tabs.filter((t) => t.group === 'Operations')} />
          <NavGroup label="Administration" items={tabs.filter((t) => t.group === 'Administration')} />
        </nav>}
      </header>

      <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">
        {setup && pathname === '/' ? <Onboarding /> : <Outlet />}
      </main>
      <Footer setup={setup} />
      {askOn && !setup && <AskPanel open={askOpen} signal={askSignal} onOpen={() => { setAskOpen(true); setAskSignal((n) => n + 1); }} onClose={() => setAskOpen(false)} />}

      {/* Phones: only the views that make sense on a small screen */}
      {!setup && <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-3 border-t border-ink-700 bg-ink-950/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        {TABS.filter((t) => t.mobile).map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end}
                   className={({ isActive }) => `relative flex flex-col items-center gap-1 py-2.5 text-2xs font-medium ${isActive ? 'text-indigo-300' : 'text-slate-500'}`}>
            {t.icon}{t.label}
          </NavLink>
        ))}
        <NavLink to="/alerts" className={`relative flex flex-col items-center gap-1 py-2.5 text-2xs font-medium ${monitoringActive ? 'text-indigo-300' : 'text-slate-500'}`}>
          {navIcon(Gauge)}Monitoring
          {alerts.open > 0 && <span className={`absolute right-[calc(50%-1.1rem)] top-1.5 h-2 w-2 rounded-full ${alerts.critical ? 'bg-rose-500' : 'bg-amber-400'}`} />}
        </NavLink>
      </nav>}
    </div>
  );
}
