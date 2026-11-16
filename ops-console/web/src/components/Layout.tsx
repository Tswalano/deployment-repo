import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { ROLE_INFO } from '../api';
import { useAuth } from '../auth';

const link = ({ isActive }: { isActive: boolean }) =>
  `whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
    isActive
      ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300'
      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100'
  }`;

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  if (!user) return null;
  const role = ROLE_INFO[user.role];

  return (
    <div className="min-h-screen">
      {user.isDemo && (
        <div className="bg-amber-100 px-4 py-2 text-center text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          You're exploring the <strong>read-only demo</strong>. Nothing you do here changes anything.
        </div>
      )}
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/85 backdrop-blur dark:border-slate-800 dark:bg-slate-950/85">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
          <div className="flex items-center gap-2 font-semibold">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-indigo-600 text-sm text-white">OC</span>
            <span className="hidden sm:inline">Ops Console</span>
          </div>
          <nav className="flex flex-1 items-center gap-1 overflow-x-auto">
            <NavLink to="/" end className={link}>Overview</NavLink>
            {user.role === 'admin' && <NavLink to="/users" className={link}>Users</NavLink>}
            {user.role === 'admin' && <NavLink to="/audit" className={link}>Audit log</NavLink>}
            {!user.isDemo && <NavLink to="/account" className={link}>Account</NavLink>}
          </nav>
          <div className="flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <div className="max-w-[10rem] truncate text-sm font-medium" title={user.username}>{user.displayName || user.username}</div>
              <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${role.badge}`}>{role.label}</span>
            </div>
            <button
              className="btn-secondary"
              onClick={async () => {
                await logout();
                navigate('/login');
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
