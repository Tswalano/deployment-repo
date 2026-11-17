import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth';

/** Console footer: brand, live status of the console, documentation, legal and support links. */
export function Footer({ setup = false }: { setup?: boolean }) {
  const { site } = useAuth();
  void setup;
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    const check = () => fetch('/api/health').then((r) => setOk(r.ok)).catch(() => setOk(false));
    void check();
    const t = setInterval(check, 60_000);
    return () => clearInterval(t);
  }, []);
  const links: [string, string][] = [['/docs', 'Documentation'], ['/terms', 'Terms of Service'], ['/privacy', 'Privacy'], ['/security', 'Security']];
  return (
    <footer className="mt-12 border-t border-ink-700">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-4 px-4 py-6 text-xs text-slate-500 sm:px-6 md:flex-row md:items-center">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <span className="flex items-center gap-2">
            <span className="grid h-5 w-5 place-items-center rounded border border-indigo-400/40 bg-indigo-500/15 text-indigo-300">
              <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden><path d="M12 3 3 20h18L12 3z" /></svg>
            </span>
            © {new Date().getFullYear()} {site.legalEntity ?? site.productName}
          </span>
          <span className="flex items-center gap-1.5" title="Health of the console itself">
            <span className={`h-1.5 w-1.5 rounded-full ${ok === null ? 'bg-slate-500' : ok ? 'bg-emerald-400' : 'bg-rose-400'}`} />
            {ok === null ? 'Checking status' : ok ? 'Console operational' : 'Console degraded'}
          </span>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-5 gap-y-2 md:ml-auto">
          {links.map(([to, label]) => <Link key={to} to={to} className="hover:text-slate-300">{label}</Link>)}
          {site.supportEmail && <a href={`mailto:${site.supportEmail}`} className="hover:text-slate-300">Contact support</a>}
        </nav>
      </div>
    </footer>
  );
}
