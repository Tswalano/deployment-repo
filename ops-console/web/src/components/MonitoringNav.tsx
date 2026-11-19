import { NavLink } from 'react-router-dom';
import { Activity, Bell } from 'lucide-react';
import { smallIcon } from './icons';

/** Monitoring section switch (Alerts | Activity), shown above both pages. */
export function MonitoringNav() {
  const item = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-1.5 rounded-md px-3 py-1 text-sm ${isActive ? 'bg-ink-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`;
  return (
    <nav aria-label="Monitoring" className="mb-4 flex items-center gap-3">
      <span className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Monitoring</span>
      <div className="flex gap-0.5 rounded-lg border border-ink-700 p-0.5">
        <NavLink to="/alerts" className={item}>{smallIcon(Bell)}Alerts</NavLink>
        <NavLink to="/activity" className={item}>{smallIcon(Activity)}Activity</NavLink>
      </div>
    </nav>
  );
}
