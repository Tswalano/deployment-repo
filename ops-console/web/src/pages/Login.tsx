import { FormEvent, useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';

export function Login() {
  const { user, refresh, site } = useAuth();
  const navigate = useNavigate();
  const [q] = useSearchParams();
  // back to where the person was headed (e.g. an invitation); only ever a path on this site
  const next = (q.get('next') ?? '').startsWith('/') && !(q.get('next') ?? '').startsWith('//') ? q.get('next')! : '/';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'login' | 'demo' | null>(null);
  const [localMode, setLocalMode] = useState(false);
  useEffect(() => { fetch('/api/health').then((r) => r.json()).then((h) => setLocalMode(h.mode === 'local-dry-run')).catch(() => undefined); }, []);

  if (user) return <Navigate to={next} replace />;

  async function run(kind: 'login' | 'demo', fn: () => Promise<unknown>) {
    setBusy(kind);
    setError(null);
    try {
      await fn();
      await refresh();
      navigate(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(null);
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run('login', () => api.login(username, password));
  };

  return (
    <div className="grid min-h-screen place-items-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <span className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-xl border border-indigo-400/40 bg-indigo-500/15 text-indigo-300"><svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M12 3 3 20h18L12 3z" /></svg></span>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100">{site.productName}</h1>
          <p className="mt-1 text-sm text-slate-500">{site.multiTenant ? 'Sign in to continue.' : 'Deployments, health and databases across EC2 instances.'}</p>
        </div>

        {localMode && (
          <div className="mb-4 rounded-xl border border-fuchsia-500/30 bg-fuchsia-500/10 p-3 text-xs text-fuchsia-200">
            Local test server: it has its own logins (not the production password). They're in
            <code className="mx-1 rounded bg-ink-900 px-1 font-mono">ops-console/.local/credentials.txt</code>,
            or choose one with <code className="rounded bg-ink-900 px-1 font-mono">ops-console/dev/local.sh --password admin</code>.
          </div>
        )}
        <form onSubmit={submit} className="card space-y-4" noValidate>
          <div>
            <label htmlFor="username" className="label">{site.multiTenant ? 'Email' : 'Username'}</label>
            <input id="username" className="input" autoComplete="username" autoFocus required
                   value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div>
            <div className="flex items-baseline justify-between">
              <label htmlFor="password" className="label">Password</label>
              {site.multiTenant && <Link to="/forgot-password" className="text-xs text-slate-400 hover:text-slate-200">Forgot password?</Link>}
            </div>
            <input id="password" type="password" className="input" autoComplete="current-password" required
                   value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {error && (
            <p role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error}</p>
          )}
          <button type="submit" className="btn-primary w-full" disabled={busy !== null || !username || !password}>
            {busy === 'login' ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        {site.multiTenant && (
          <p className="mt-6 text-center text-sm text-slate-400">New here? <Link to="/signup" className="text-indigo-300 hover:underline">Create an account</Link></p>
        )}
        {site.demo !== false && (
        <div className="mt-6 rounded-xl border border-dashed border-ink-600 p-4 text-center">
          <p className="text-sm text-slate-400">Just looking around?</p>
          <button className="btn-secondary mt-3 w-full" disabled={busy !== null} onClick={() => void run('demo', api.demo)}>
            {busy === 'demo' ? 'Opening demo…' : 'Try the read-only demo'}
          </button>
        </div>
        )}
      </div>
    </div>
  );
}
