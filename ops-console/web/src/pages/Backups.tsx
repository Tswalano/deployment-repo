import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, BackupVerification, InstanceBackups } from '../api';
import { useAuth } from '../auth';
import { ago, Alert, bytes, Kpi, PageHeader, Skeleton } from '../components/ui';
import { usePoll } from '../usePoll';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong.');
/** "Mon 2026-11-16 15:34:13 UTC" (systemd) → Date */
const sysdate = (s: string | null | undefined) => (s ? new Date(s.replace(/^\w{3} /, '').replace(' UTC', 'Z').replace(' ', 'T')) : null);
const until = (d: Date | null) => {
  if (!d || Number.isNaN(d.getTime())) return '—';
  const m = Math.round((d.getTime() - Date.now()) / 60_000);
  return m <= 0 ? 'due now' : m < 60 ? `in ${m} min` : m < 1440 ? `in ${Math.round(m / 60)}h` : `in ${Math.round(m / 1440)}d`;
};

function VerifyBadge({ v }: { v: BackupVerification | undefined }) {
  if (!v) return <span className="pill-mute">not tested</span>;
  return v.ok
    ? <span className="pill-ok" title={`Restored ${v.tables} tables / ${v.rows} rows (live: ${v.liveTables} / ${v.liveRows}) in ${v.seconds}s, ${v.trigger} ${ago(v.at)}`}>restorable</span>
    : <span className="pill-bad" title={v.error ?? ''}>restore failed</span>;
}

function InstanceSection({ b, canOperate, isAdmin, downloads, reload }:
  { b: InstanceBackups; canOperate: boolean; isAdmin: boolean; downloads: boolean; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad' | 'warn'; text: string } | null>(null);
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});

  const files = b.files ?? [];
  const dbs = [...new Set(files.filter((f) => f.file.endsWith('.dump')).map((f) => f.db))];
  const latestVerify = (db: string, file?: string) => b.verifications.find((v) => v.db === db && (!file || v.file === file));
  const next = sysdate(b.timer?.next);
  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key); setMsg(null);
    try { setMsg({ tone: 'ok', text: await fn() }); await reload(); } catch (e) { setMsg({ tone: 'bad', text: errMsg(e) }); } finally { setBusy(null); }
  };
  const untested = dbs.filter((db) => !latestVerify(db)?.ok).length;

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-medium text-slate-100">{b.instance}</h2>
        {canOperate && (
          <button className="btn-secondary" disabled={busy !== null || b.timer?.running}
                  onClick={() => void run('run', async () => { const r = await api.runBackup(b.instanceId); return `Backup finished in ${r.seconds}s.`; })}>
            {busy === 'run' || b.timer?.running ? 'Backing up…' : 'Back up now'}
          </button>
        )}
      </div>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Last backup" tone={!b.lastRun ? 'mute' : b.lastRun.ok ? 'ok' : 'bad'} value={b.lastRun ? ago(b.lastRun.at) : 'never'} unit={b.lastRun ? (b.lastRun.ok ? 'succeeded' : 'FAILED') : undefined} />
        <Kpi label="Next backup" tone="info" value={until(next)} unit="15:30 UTC daily" />
        <Kpi label="Restore tests" tone={untested ? 'warn' : 'ok'} value={`${dbs.length - untested}/${dbs.length}`} unit="latest dumps restorable" className="hidden md:block" />
        <Kpi label="Stored" tone="info" value={bytes(b.lastRun?.totalBytes ?? files.reduce((n, f) => n + f.bytes, 0))} unit={`${b.lastRun?.keepDays ?? 14} days kept · ${bytes(b.diskFree)} free`} className="hidden md:block" />
      </div>

      <p className="rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-4 py-2.5 text-xs text-amber-200/90">
        Backups are stored on the instance's own disk ({b.location}). They protect against bad deploys and mistakes, not against losing the disk itself.
      </p>

      <div className="grid gap-5 xl:grid-cols-2">
        {dbs.map((db) => {
          const mine = files.filter((f) => f.db === db);
          const shown = showAll[db] ? mine : mine.slice(0, 5);
          const lv = latestVerify(db);
          return (
            <div key={db} className="card overflow-hidden p-0">
              <div className="flex flex-wrap items-start justify-between gap-2 px-5 py-4">
                <div className="min-w-0">
                  <h3 className="num font-medium text-slate-100">{db}</h3>
                  <p className="mt-0.5 truncate text-xs text-slate-500">
                    {mine.length} dumps · {lv ? <>last restore test {ago(lv.at)}: {lv.ok ? `${lv.tables} tables, ${lv.rows?.toLocaleString()} rows in ${lv.seconds}s` : 'failed'}</> : 'never restore-tested'}
                  </p>
                </div>
                <VerifyBadge v={lv} />
              </div>
              <table className="tbl">
                <thead><tr><th className="w-[34%] sm:w-[30%]">Taken</th><th className="w-[26%] text-right sm:w-[18%]">Size</th><th className="hidden w-[22%] sm:table-cell">Restore test</th><th className="text-right">{canOperate ? 'Actions' : ''}</th></tr></thead>
                <tbody>{shown.map((f) => {
                  const v = latestVerify(db, f.file);
                  return (
                    <tr key={f.file}>
                      <td title={`${f.file} · ${f.at}`}>{ago(f.at)}</td>
                      <td className="num text-right">{bytes(f.bytes)}</td>
                      <td className="hidden sm:table-cell"><VerifyBadge v={v} /></td>
                      <td className="text-right">
                        {canOperate && (
                          <div className="flex justify-end gap-1.5">
                            <button className="btn-ghost px-2 py-1 text-xs" disabled={busy !== null} title="Restore into a throwaway database, count tables and rows, then drop it"
                                    onClick={() => void run(`v:${f.file}`, async () => {
                                      const r = await api.verifyBackup(b.instanceId, db, f.file);
                                      return r.ok ? `${f.file} restores cleanly: ${r.tables} tables, ${r.rows?.toLocaleString()} rows (live has ${r.liveTables} tables).` : `Restore test failed: ${r.error}`;
                                    })}>{busy === `v:${f.file}` ? 'Testing…' : <><span className="sm:hidden">Test</span><span className="hidden sm:inline">Test restore</span></>}</button>
                            {isAdmin && downloads && (
                              <button className="btn-ghost hidden px-2 py-1 text-xs md:inline-flex" disabled={busy !== null}
                                      onClick={() => {
                                        if (!window.confirm(`Download ${f.file}? It contains every row of the ${db} database, including personal data. The download is logged.`)) return;
                                        void run(`d:${f.file}`, async () => {
                                          const r = await api.downloadBackup(b.instanceId, db, f.file);
                                          window.location.assign(r.url);
                                          return `Downloading ${f.file} (${bytes(r.bytes)}). SHA-256 ${r.sha256.slice(0, 16)}…; the link expires in 5 minutes.`;
                                        });
                                      }}>{busy === `d:${f.file}` ? 'Preparing…' : 'Download'}</button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}</tbody>
              </table>
              {mine.length > 5 && (
                <div className="border-t border-ink-800 p-2 text-center"><button className="btn-ghost px-3 py-1 text-xs" onClick={() => setShowAll({ ...showAll, [db]: !showAll[db] })}>
                  {showAll[db] ? 'Show fewer' : `Show all ${mine.length}`}
                </button></div>
              )}
            </div>
          );
        })}
      </div>

      {canOperate && (
        <details className="card text-sm">
          <summary className="cursor-pointer font-medium text-slate-200">How to restore a database by hand</summary>
          <div className="mt-3 space-y-2 text-slate-400">
            <p>The console never restores over a live database. To do it deliberately, on the instance as ec2-user (take a fresh backup first):</p>
            <pre className="overflow-x-auto rounded-lg bg-ink-950 p-3 font-mono text-xs text-slate-300">{`sudo systemctl stop <service>
pg_restore -h localhost -U postgres -d <db> --clean --if-exists /var/backups/app-db/<db>/<file>.dump
sudo systemctl start <service>`}</pre>
          </div>
        </details>
      )}
    </section>
  );
}

const STATE: Record<string, [string, string]> = {
  stopped: ['Stopped', 'bg-slate-500'], stopping: ['Stopping', 'bg-amber-400'], pending: ['Starting', 'bg-amber-400'],
  running: ['Running, not responding', 'bg-rose-400'], terminated: ['Terminated', 'bg-slate-600'],
};

/** Servers whose backups can't be read right now (stopped or not responding), with a link to start or reboot them. */
function Unreachable({ list }: { list: InstanceBackups[] }) {
  if (!list.length) return null;
  return (
    <section>
      <h2 className="font-medium text-slate-100">Other servers</h2>
      <p className="mt-1 text-sm text-slate-500">Backups on these servers can't be read until they are running and reachable.</p>
      <div className="mt-3 overflow-x-auto rounded-xl border border-ink-700">
        <table className="w-full min-w-[36rem] text-sm">
          <thead className="bg-ink-900 text-left text-xs text-slate-500">
            <tr><th className="px-4 py-2 font-medium">Server</th><th className="px-4 py-2 font-medium">Region</th><th className="px-4 py-2 font-medium">Status</th><th className="px-4 py-2 font-medium">Last reachable</th><th className="px-4 py-2" /></tr>
          </thead>
          <tbody className="divide-y divide-ink-800">
            {list.map((b) => {
              const [label, dot] = STATE[b.state ?? ''] ?? ['Not reachable', 'bg-rose-400'];
              return (
                <tr key={b.instanceId}>
                  <td className="px-4 py-2.5 text-slate-200">{b.instance}</td>
                  <td className="num px-4 py-2.5 text-slate-400">{b.region ?? '—'}</td>
                  <td className="px-4 py-2.5 text-slate-300" title={b.error}><span className="inline-flex items-center gap-2"><span className={`h-1.5 w-1.5 rounded-full ${dot}`} />{label}</span></td>
                  <td className="px-4 py-2.5 text-slate-400">{b.lastOkAt ? ago(b.lastOkAt) : 'never'}</td>
                  <td className="px-4 py-2.5 text-right"><Link to={`/instances/${b.instanceId}`} className="text-indigo-300 hover:underline">Open server →</Link></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function Backups() {
  const { user } = useAuth();
  const { data, error, reload } = usePoll(() => api.backups(), 60_000);
  const canOperate = !!user && !user.isDemo && (user.role === 'admin' || user.role === 'deployer');
  return (
    <div>
      <PageHeader title="Backups" subtitle="Nightly pg_dump of every app database, restore-tested automatically after each run" />
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      {!data ? <div className="space-y-3"><Skeleton className="h-28" /><Skeleton className="h-64" /></div> : (
        <div className="space-y-10">
          {data.instances.filter((b) => b.ok).map((b) => (
            <InstanceSection key={b.instanceId} b={b} canOperate={canOperate} isAdmin={user?.role === 'admin' && !user.isDemo}
                             downloads={data.downloads} reload={async () => { await reload(); }} />
          ))}
          <Unreachable list={data.instances.filter((b) => !b.ok)} />
        </div>
      )}
    </div>
  );
}
