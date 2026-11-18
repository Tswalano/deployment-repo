import { useTheme, type ThemePref } from '../theme';

const ICONS: [ThemePref, string, string][] = [
  ['light', 'Light', 'M12 4V2m0 20v-2m8-8h2M2 12h2m13.7-5.7 1.4-1.4M4.9 19.1l1.4-1.4m0-11.4L4.9 4.9m14.2 14.2-1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z'],
  ['dark', 'Dark', 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z'],
  ['system', 'System', 'M4 5h16v11H4zM8 20h8M12 16v4'],
];

/** Compact light / dark / system switch for public pages (the console has it in the profile menu). */
export function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-ink-600 p-0.5" role="radiogroup" aria-label="Theme">
      {ICONS.map(([v, label, d]) => (
        <button key={v} type="button" role="radio" aria-checked={theme === v} aria-label={label} title={label} onClick={() => setTheme(v)}
                className={`grid h-7 w-7 place-items-center rounded-md ${theme === v ? 'bg-ink-800 text-slate-100' : 'text-slate-500 hover:text-slate-200'}`}>
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden><path d={d} /></svg>
        </button>
      ))}
    </div>
  );
}
