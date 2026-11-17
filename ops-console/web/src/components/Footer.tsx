import { Link } from 'react-router-dom';
import { useAuth } from '../auth';

/** Console footer: product, year, and the account pages. */
export function Footer() {
  const { site, user } = useAuth();
  const links: [string, string][] = [['/account', 'Your account']];
  if (site.multiTenant) links.push(['/team', 'Team']);
  if (user?.role === 'admin' && !user.isDemo) {
    if (site.multiTenant) links.push(['/billing', 'Billing']);
    links.push(['/settings', 'Settings']);
  }
  return (
    <footer className="mt-10 border-t border-ink-700">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-5 text-xs text-slate-500 sm:px-6">
        <span>© {new Date().getFullYear()} {site.productName}</span>
        {site.multiTenant && <span className="hidden sm:inline">Your servers and data stay in your own AWS account.</span>}
        <nav aria-label="Footer" className="ml-auto flex flex-wrap gap-x-5 gap-y-1">
          {links.map(([to, label]) => <Link key={to} to={to} className="hover:text-slate-300">{label}</Link>)}
        </nav>
      </div>
    </footer>
  );
}
