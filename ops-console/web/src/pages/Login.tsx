import { FormEvent, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';

export function Login() {
  const { user, refresh } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'login' | 'demo' | null>(null);

  if (user) return <Navigate to="/" replace />;

  async function run(kind: 'login' | 'demo', fn: () => Promise<unknown>) {
    setBusy(kind);
    setError(null);
    try {
      await fn();
      await refresh();
      navigate('/');
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
          <span className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-xl bg-indigo-600 text-lg font-semibold text-white">OC</span>
          <h1 className="text-2xl font-semibold tracking-tight">Ops Console</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Deployments, health and databases across EC2 instances.</p>
        </div>

        <form onSubmit={submit} className="card space-y-4" noValidate>
          <div>
            <label htmlFor="username" className="label">Username</label>
            <input id="username" className="input" autoComplete="username" autoFocus required
                   value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div>
            <label htmlFor="password" className="label">Password</label>
            <input id="password" type="password" className="input" autoComplete="current-password" required
                   value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {error && (
            <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/60 dark:text-rose-300">{error}</p>
          )}
          <button type="submit" className="btn-primary w-full" disabled={busy !== null || !username || !password}>
            {busy === 'login' ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <div className="mt-6 rounded-xl border border-dashed border-slate-300 p-4 text-center dark:border-slate-700">
          <p className="text-sm text-slate-600 dark:text-slate-400">Just looking around?</p>
          <button className="btn-secondary mt-3 w-full" disabled={busy !== null} onClick={() => void run('demo', api.demo)}>
            {busy === 'demo' ? 'Opening demo…' : 'Try the read-only demo'}
          </button>
        </div>
      </div>
    </div>
  );
}
