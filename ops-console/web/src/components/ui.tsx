import { ReactNode, useId } from 'react';

// ------------------------------------------------------------------ formatting
export const bytes = (b: number | null | undefined): string => {
  if (b == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b >= 100 || i === 0 ? b.toFixed(0) : b.toFixed(1)} ${u[i]}`;
};
export const pct = (used: number, total: number): number => (total > 0 ? Math.round((used / total) * 1000) / 10 : 0);
export const dur = (s: number | null | undefined): string => {
  if (s == null) return '—';
  if (s < 60) return `${Math.round(s)}s`;
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};
export const ago = (iso: string | null | undefined): string => {
  if (!iso) return 'never';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return `${Math.max(1, Math.round(s))}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

// ------------------------------------------------------------------ primitives
export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'mute';
const DOT: Record<Tone, string> = { ok: 'bg-emerald-400', warn: 'bg-amber-400', bad: 'bg-rose-400', info: 'bg-indigo-400', mute: 'bg-slate-500' };
const TEXT: Record<Tone, string> = { ok: 'text-emerald-300', warn: 'text-amber-300', bad: 'text-rose-300', info: 'text-indigo-300', mute: 'text-slate-400' };

export const Dot = ({ tone, pulse }: { tone: Tone; pulse?: boolean }) => (
  <span className="relative inline-flex h-1.5 w-1.5">
    {pulse && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 motion-reduce:animate-none ${DOT[tone]}`} />}
    <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${DOT[tone]}`} />
  </span>
);

export const Eyebrow = ({ tone, children }: { tone?: Tone; children: ReactNode }) => (
  <div className="eyebrow">{tone && <Dot tone={tone} />}{children}</div>
);

export function Kpi({ label, tone, value, unit, sub, className = '' }:
  { label: string; tone?: Tone; value: ReactNode; unit?: string; sub?: string; className?: string }) {
  return (
    <div className={`card min-w-0 p-4 ${className}`}>
      <Eyebrow tone={tone}>{label}</Eyebrow>
      <div className="mt-3 flex items-baseline gap-2 truncate">
        <span className={`num text-2xl font-medium tracking-tight sm:text-[1.65rem] ${tone && tone !== 'ok' && tone !== 'info' ? TEXT[tone] : 'text-slate-100'}`}>{value}</span>
        {unit && <span className="truncate text-xs text-slate-500">{unit}</span>}
      </div>
      {sub && <div className="mt-1 truncate text-xs text-slate-500" title={sub}>{sub}</div>}
    </div>
  );
}

/** Thin labelled bar (CPU/MEM/DISK style). */
export function Meter({ label, value, tone }: { label: string; value: number | null; tone?: Tone }) {
  const v = value == null ? 0 : Math.max(0, Math.min(100, value));
  const t: Tone = tone ?? (v >= 90 ? 'bad' : v >= 75 ? 'warn' : 'ok');
  const color = { ok: 'bg-sky-400', warn: 'bg-amber-400', bad: 'bg-rose-400', info: 'bg-indigo-400', mute: 'bg-slate-500' }[t];
  return (
    <div className="flex items-center gap-3 text-2xs">
      <span className="w-8 shrink-0 font-semibold uppercase tracking-wider text-slate-500">{label}</span>
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-ink-700" role="meter" aria-label={label} aria-valuenow={v} aria-valuemin={0} aria-valuemax={100}>
        <div className={`h-full rounded-full ${color}`} style={{ width: `${v}%` }} />
      </div>
      <span className="num w-10 shrink-0 text-right text-slate-400">{value == null ? '—' : `${Math.round(v)}%`}</span>
    </div>
  );
}

/** Area sparkline from a series (0–100 by default). */
export function Sparkline({ values, tone = 'info', max = 100, height = 64 }: { values: number[]; tone?: Tone; max?: number; height?: number }) {
  const stroke = { ok: '#34d399', warn: '#fbbf24', bad: '#fb7185', info: '#60a5fa', mute: '#64748b' }[tone];
  const id = `spark${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  if (values.length < 2) {
    return <div className="grid place-items-center text-2xs text-slate-600" style={{ height }}>collecting history…</div>;
  }
  const w = 300, h = height, top = Math.max(max, ...values);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 4 - (v / top) * (h - 10)] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="block w-full" style={{ height }} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L${w},${h} L0,${h} Z`} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={stroke} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Grid of status cells (one per app/pod). */
export function Cells({ items, size = 'md' }: { items: { key: string; tone: Tone; title: string }[]; size?: 'sm' | 'md' }) {
  const c = { ok: 'bg-emerald-500/70 hover:bg-emerald-400', warn: 'bg-amber-400/80 hover:bg-amber-300', bad: 'bg-rose-500/85 hover:bg-rose-400', info: 'bg-indigo-400/80', mute: 'bg-ink-600' };
  const s = size === 'sm' ? 'h-3 w-3 rounded-[3px]' : 'h-5 w-5 rounded-[4px] sm:h-6 sm:w-6';
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((it) => <span key={it.key} title={it.title} className={`${s} ${c[it.tone]} transition-colors`} />)}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="truncate text-lg font-semibold tracking-tight text-slate-100 sm:text-xl">{title}</h1>
        {subtitle && <p className="mt-1 truncate text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export const Alert = ({ tone = 'bad', children }: { tone?: 'bad' | 'ok' | 'warn'; children: ReactNode }) => (
  <p role={tone === 'bad' ? 'alert' : 'status'} className={`rounded-lg border px-3 py-2 text-sm ${{
    bad: 'border-rose-500/30 bg-rose-500/10 text-rose-200',
    ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
    warn: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
  }[tone]}`}>{children}</p>
);

export const Skeleton = ({ className = '' }: { className?: string }) => (
  <div className={`animate-pulse rounded-lg bg-ink-800 motion-reduce:animate-none ${className}`} />
);

/** Shown instead of admin-heavy pages on phones. */
export const DesktopOnly = ({ title }: { title: string }) => (
  <div className="card mt-6 text-center md:hidden">
    <p className="font-medium text-slate-200">{title} is available on larger screens</p>
    <p className="mt-1 text-sm text-slate-500">Open the Ops Console on a tablet or desktop to manage this.</p>
  </div>
);
