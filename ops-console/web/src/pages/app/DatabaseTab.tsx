import { AppDetailData, DbPoint } from '../../api';
import { ago, bytes, dur, Kpi, Skeleton, Sparkline } from '../../components/ui';
import { Facts, num, Section } from './shared';

function Chart({ title, value, values, tone, max }: { title: string; value: string; values: number[]; tone: 'info' | 'ok' | 'warn'; max?: number }) {
  return (
    <div className="card flex min-w-0 flex-col p-0">
      <div className="flex items-baseline justify-between px-5 pt-4"><span className="text-sm text-slate-400">{title}</span><span className="num text-sm text-slate-200">{value}</span></div>
      <div className="mt-auto pt-3"><Sparkline values={values} tone={tone} max={max} height={56} /></div>
    </div>
  );
}

export function DatabaseTab({ detail, series, operator }: { detail: AppDetailData | null; series: DbPoint[]; operator: boolean }) {
  if (!detail) return <div className="space-y-3"><Skeleton className="h-28" /><Skeleton className="h-64" /></div>;
  const d = detail.database;
  if (!d) return <div className="card text-sm text-slate-500">This app has no database configured.</div>;
  if (!d.ok) return <div className="card text-sm text-rose-300">Database unavailable{d.error ? `: ${d.error}` : ''}.</div>;

  const tps = series.map((p) => p.tps).filter((x): x is number => x != null);
  const hits = series.map((p) => p.cacheHitPct).filter((x): x is number => x != null);
  const sizes = series.map((p) => p.size).filter((x): x is number => x != null);
  const conns = series.map((p) => p.connections).filter((x): x is number => x != null);
  const deadlocks24h = series.reduce((n, p) => n + (p.deadlocks ?? 0), 0);
  const growth = sizes.length > 1 ? sizes[sizes.length - 1] - sizes[0] : null;
  const hit = d.stats.cache_hit_pct ?? null;
  const connTotal = Object.values(d.connectionsByState).reduce((a, b) => a + b, 0);
  const deadPct = d.rows ? Math.round((d.deadRows / (d.rows + d.deadRows)) * 100) : 0;
  const longest = d.activeQueries[0];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Size" tone="info" value={bytes(d.size)} unit={growth != null ? `${growth >= 0 ? '+' : '−'}${bytes(Math.abs(growth))}/24h` : `${d.tableCount} tables`} />
        <Kpi label="Cache hit" tone={hit == null ? 'mute' : hit >= 99 ? 'ok' : hit >= 95 ? 'warn' : 'bad'} value={hit == null ? '—' : `${hit.toFixed(1)}%`} unit="overall" />
        <Kpi label="Throughput" tone="info" value={tps.length ? tps[tps.length - 1].toFixed(2) : '—'} unit="tx/s" className="hidden md:block" />
        <Kpi label="Connections" tone="ok" value={connTotal} unit={Object.entries(d.connectionsByState).map(([k, v]) => `${v} ${k}`).join(' · ') || 'none'} className="hidden md:block" />
        <Kpi label="Waiting locks" tone={d.blocked || deadlocks24h ? 'bad' : 'ok'} value={d.blocked ?? 0} unit={`${deadlocks24h} deadlocks/24h`} className="hidden xl:block" />
        <Kpi label="Dead rows" tone={deadPct > 20 ? 'warn' : 'ok'} value={`${deadPct}%`} unit={`${num(d.deadRows)} rows`} className="hidden xl:block" />
      </div>

      <div className="hidden gap-5 sm:grid sm:grid-cols-2 xl:grid-cols-4">
        <Chart title="Transactions/s · 24h" value={tps.length ? tps[tps.length - 1].toFixed(2) : '—'} values={tps} tone="info" max={Math.max(1, ...tps)} />
        <Chart title="Cache hit · 24h" value={hits.length ? `${hits[hits.length - 1].toFixed(1)}%` : '—'} values={hits} tone="ok" />
        <Chart title="Size · 24h" value={bytes(d.size)} values={sizes} tone="info" max={Math.max(...sizes, 1) * 1.05} />
        <Chart title="Connections · 24h" value={String(connTotal)} values={conns} tone="warn" max={Math.max(5, ...conns)} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="hidden min-w-0 space-y-5 md:block">
          <Section title="Active queries" sub="Statements running now: timing and state only, the SQL text is never collected" flush>
            {d.activeQueries.length === 0 ? <p className="px-5 pb-5 text-sm text-slate-500">Nothing running right now.</p> : (
              <table className="tbl">
                <thead><tr><th className="w-[16%]">PID</th><th className="w-[26%]">State</th><th className="w-[18%] text-right">Running</th><th>Waiting on</th>{operator && <th className="hidden w-[20%] md:table-cell">Client</th>}</tr></thead>
                <tbody>{d.activeQueries.map((q) => (
                  <tr key={q.pid}><td className="num">{q.pid}</td><td className={q.state.startsWith('idle in') ? 'text-amber-300' : ''}>{q.state}</td>
                    <td className={`num text-right ${q.seconds > 60 ? 'text-rose-300' : ''}`}>{dur(q.seconds)}</td><td title={q.wait ?? ''}>{q.wait ?? '—'}</td>
                    {operator && <td className="hidden md:table-cell" title={`${q.user} · ${q.app}`}>{q.user}{q.app ? ` · ${q.app}` : ''}</td>}</tr>
                ))}</tbody>
              </table>
            )}
          </Section>

          {operator && d.tables && (
            <Section title="Tables" sub={`${d.tableCount} tables · largest first · dead rows above 20% need a VACUUM`} flush>
              <table className="tbl">
                <thead><tr>
                  <th className="w-[28%]">Table</th><th className="w-[11%] text-right">Rows</th><th className="w-[9%] text-right">Dead</th>
                  <th className="w-[11%] text-right">Size</th><th className="hidden w-[11%] text-right xl:table-cell">Indexes</th>
                  <th className="hidden w-[15%] text-right lg:table-cell">Seq / idx scans</th><th className="hidden xl:table-cell">Vacuumed</th>
                </tr></thead>
                <tbody>{d.tables.map((t) => {
                  const deadHigh = t.rows != null && t.dead > 50 && t.dead > (t.rows ?? 0) * 0.2;
                  const seqHeavy = t.seqScans > 1000 && t.seqScans > t.idxScans * 10;
                  return (
                    <tr key={t.table}>
                      <td className="num text-xs" title={t.table}>{t.table.replace(/^public\./, '')}</td>
                      <td className="num text-right">{t.rows == null ? '—' : num(t.rows)}</td>
                      <td className={`num text-right ${deadHigh ? 'text-amber-300' : ''}`}>{num(t.dead)}</td>
                      <td className="num text-right">{bytes(t.size)}</td>
                      <td className="num hidden text-right xl:table-cell">{bytes(t.indexSize)}</td>
                      <td className={`num hidden text-right lg:table-cell ${seqHeavy ? 'text-amber-300' : ''}`} title={seqHeavy ? 'Mostly sequential scans: a missing index?' : ''}>{num(t.seqScans)} / {num(t.idxScans)}</td>
                      <td className="hidden xl:table-cell" title={t.lastVacuum ?? 'never'}>{t.lastVacuum ? ago(t.lastVacuum) : 'never'}</td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </Section>
          )}
        </div>

        <div className="min-w-0 space-y-5">
          <Section title="Activity since stats reset" sub={d.statsReset ? `reset ${ago(d.statsReset)}` : undefined}>
            <Facts rows={[
              ['Commits', num(d.stats.xact_commit)], ['Rollbacks', num(d.stats.xact_rollback)],
              ['Rows inserted', num(d.stats.tup_inserted)], ['Rows updated', num(d.stats.tup_updated)], ['Rows deleted', num(d.stats.tup_deleted)],
              ['Deadlocks', num(d.stats.deadlocks)], ['Temp files', `${num(d.stats.temp_files)} · ${bytes(d.stats.temp_bytes ?? 0)}`],
              ['Migrations applied', d.migrationsApplied == null ? '—' : num(d.migrationsApplied)],
            ]} />
          </Section>
          <Section title="Health checks">
            <ul className="space-y-2 text-sm">
              {[
                [hit == null || hit >= 99, `Cache hit ${hit == null ? 'unknown' : `${hit.toFixed(1)}%`}`, 'below 99% means the working set no longer fits in memory'],
                [!longest || longest.seconds < 60, longest ? `Longest statement ${dur(longest.seconds)}` : 'No long-running statements', 'over a minute usually means a stuck query or a missing index'],
                [!d.activeQueries.some((q) => q.state.startsWith('idle in')), 'No idle-in-transaction sessions', 'an app left a transaction open; it holds locks'],
                [!d.blocked, `${d.blocked ?? 0} waiting locks`, 'sessions blocked by another session'],
                [deadPct <= 20, `${deadPct}% dead rows`, 'autovacuum is behind'],
                ...(operator && d.unusedIndexes ? [[d.unusedIndexes.length === 0, `${d.unusedIndexes.length} unused indexes`, d.unusedIndexes.map((i) => `${i.index} (${bytes(i.size)})`).join(', ') || 'every index has been used'] as [boolean, string, string]] : []),
              ].map(([ok, label, hint]) => (
                <li key={label as string} className="flex items-start gap-2.5" title={hint as string}>
                  <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${ok ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                  <span className="min-w-0"><span className="text-slate-200">{label}</span><span className="block truncate text-xs text-slate-500">{hint}</span></span>
                </li>
              ))}
            </ul>
          </Section>
        </div>
      </div>
    </div>
  );
}
