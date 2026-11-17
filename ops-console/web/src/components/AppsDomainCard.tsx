import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { Alert } from './ui';

/** Settings → Apps domain (multi-customer mode): the domain new apps get subdomains of (a Route 53 zone in your account). */
export function AppsDomainCard() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' && !user.isDemo;
  const [current, setCurrent] = useState<string | null>(null);
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  useEffect(() => { api.appsDomain().then((d) => { setCurrent(d?.domain ?? null); setDomain(d?.domain ?? ''); }).catch(() => undefined); }, []);
  return (
    <section className="card space-y-4">
      <div>
        <h2 className="font-medium text-slate-100">Apps domain</h2>
        <p className="mt-1 text-sm text-slate-400">New apps get an address under this domain, for example <code>shop.{current ?? 'acme.com'}</code>. Its DNS must be a hosted zone in Route 53 in your connected AWS account; the console adds and removes the apps' records there.</p>
      </div>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <form className="flex flex-wrap items-end gap-3" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setMsg(null);
        try { const d = await api.setAppsDomain(domain.trim()); setCurrent(d.domain); setMsg({ tone: 'ok', text: `Apps will get addresses under ${d.domain}.` }); }
        catch (e2) { setMsg({ tone: 'bad', text: e2 instanceof ApiError ? e2.message : 'Saving failed.' }); } finally { setBusy(false); }
      }}>
        <div className="min-w-[16rem] flex-1">
          <label className="label" htmlFor="apps-domain">Domain</label>
          <input id="apps-domain" className="input num" placeholder="acme.com or apps.acme.com" value={domain} disabled={!isAdmin} onChange={(e) => setDomain(e.target.value.toLowerCase().trim())} />
        </div>
        {isAdmin && <button className="btn-primary" disabled={busy || !domain || domain === current}>{busy ? 'Checking…' : 'Save'}</button>}
      </form>
    </section>
  );
}
