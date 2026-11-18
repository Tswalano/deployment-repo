import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';

/** /demo: opens the read-only demo in one step (the link used on portfolios and the landing page). */
export function Demo() {
  const { user, refresh } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (user?.isDemo) { navigate('/', { replace: true }); return; }
    if (user) { setError('Signed in already: sign out first to open the demo.'); return; }
    api.demo().then(async () => { await refresh(); navigate('/', { replace: true }); })
      .catch((e) => setError(e instanceof ApiError && e.status === 404 ? "The demo isn't available right now." : 'The demo could not be opened. Try again in a moment.'));
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="max-w-sm text-center">
        {!error ? <p className="text-sm text-slate-400">Opening the read-only demo…</p> : (
          <>
            <p className="text-sm text-slate-300">{error}</p>
            <div className="mt-4 flex justify-center gap-2">
              <Link to="/" className="btn-secondary">Home</Link>
              <Link to="/login" className="btn-ghost">Sign in</Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
