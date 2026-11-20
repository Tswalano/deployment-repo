import { useEffect, useState } from 'react';
import { AddressMode, api, ApiError, AppAddresses } from '../api';
import { useAuth } from '../auth';
import { Alert } from './ui';

/**
 * Settings → App addresses (multi-customer mode): how new apps get their web address.
 *   platform - provided addresses (shop.<workspace>.<platform domain>), when the platform offers them
 *   route53  - a domain whose DNS is in Route 53 in the connected AWS account (records managed automatically)
 *   external - a domain at another DNS provider (one A record per app, then HTTPS from the app's page)
 */
export function AppsDomainCard() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' && !user.isDemo;
  const [s, setS] = useState<AppAddresses | null>(null);
  const [mode, setMode] = useState<AddressMode>('route53');
  // one field per option: a domain saved for Route 53 never pre-fills the other DNS provider option (and vice versa)
  const [domains, setDomains] = useState<Record<'route53' | 'external', string>>({ route53: '', external: '' });
  const domain = mode === 'platform' ? '' : domains[mode];
  const setDomain = (v: string) => { if (mode !== 'platform') setDomains((d) => ({ ...d, [mode]: v })); };
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  useEffect(() => {
    api.appAddresses().then((r) => {
      setS(r);
      const saved = r.appsDomain;
      const m: AddressMode = saved?.mode ?? (saved ? 'route53' : r.platform ? 'platform' : 'route53');
      setMode(m);
      if (saved?.domain && m !== 'platform') setDomains((d) => ({ ...d, [m]: saved.domain! }));
    }).catch(() => undefined);
  }, []);
  if (!s) return null;

  const savedMode: AddressMode | null = s.appsDomain ? (s.appsDomain.mode ?? 'route53') : s.current?.kind === 'platform' ? 'platform' : null;
  const unchanged = mode === savedMode && (mode === 'platform' || domain === (s.appsDomain?.domain ?? ''));
  const options: { id: AddressMode; title: string; body: string }[] = [
    ...(s.platform ? [{ id: 'platform' as const, title: 'Provided addresses', body: `No domain needed: apps get addresses like <app-name>.${s.platform.base}, with HTTPS.` }] : []),
    { id: 'route53', title: 'Domain in Route 53', body: 'A domain whose DNS is a hosted zone in the connected AWS account. Records are created and removed automatically.' },
    { id: 'external', title: 'Domain at another DNS provider', body: 'Any domain. After creating an app, add one A record at the DNS provider; HTTPS is then enabled from the app’s page.' },
  ];

  return (
    <section id="addresses" className="card space-y-4">
      <div>
        <h2 className="font-medium text-slate-100">App addresses</h2>
        <p className="mt-1 text-sm text-slate-400">
          How new apps get their web address.{s.current ? <> Currently: <code className="num text-slate-200">&lt;app-name&gt;.{s.current.base}</code></> : ' Not chosen yet.'}
        </p>
      </div>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <form className="space-y-4" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setMsg(null);
        try {
          const r = await api.setAppAddresses({ mode, domain: mode === 'platform' ? undefined : domain.trim() });
          setS((prev) => ({ ...r, platform: prev?.platform }));
          setMsg({ tone: 'ok', text: r.current ? `New apps get addresses like <app-name>.${r.current.base}.` : 'Saved.' });
        } catch (e2) { setMsg({ tone: 'bad', text: e2 instanceof ApiError ? e2.message : 'Saving failed.' }); } finally { setBusy(false); }
      }}>
        <div className="grid gap-2 md:grid-cols-3" role="radiogroup" aria-label="Address type">
          {options.map((o) => (
            <button key={o.id} type="button" role="radio" aria-checked={mode === o.id} disabled={!isAdmin} onClick={() => setMode(o.id)}
                    className={`rounded-xl border px-4 py-3 text-left transition-colors ${mode === o.id ? 'border-indigo-400/60 bg-indigo-500/10' : 'border-ink-700 hover:border-ink-500'}`}>
              <span className="flex items-center gap-2 text-sm font-medium text-slate-100">
                <span className={`grid h-4 w-4 place-items-center rounded-full border ${mode === o.id ? 'border-indigo-300' : 'border-ink-500'}`}>
                  {mode === o.id && <span className="h-2 w-2 rounded-full bg-indigo-300" />}
                </span>
                {o.title}
              </span>
              <span className="mt-1.5 block text-xs leading-5 text-slate-400">{o.body}</span>
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          {mode !== 'platform' && (
            <div className="min-w-[16rem] flex-1">
              <label className="label" htmlFor="apps-domain">Domain</label>
              <input id="apps-domain" key={mode} className="input num" placeholder={mode === 'route53' ? 'A domain with a Route 53 hosted zone, e.g. acme.com' : 'Any domain, e.g. acme.com or apps.acme.com'} value={domain} disabled={!isAdmin}
                     onChange={(e) => setDomain(e.target.value.toLowerCase().trim())} />
            </div>
          )}
          {isAdmin && <button className="btn-primary" disabled={busy || unchanged || (mode !== 'platform' && !domain)}>{busy ? 'Checking…' : 'Save'}</button>}
        </div>
      </form>
    </section>
  );
}
