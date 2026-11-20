import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, AppRuntime, PyFramework, Deployment, Detection, GithubRepo, Instance, NewAppCheck, NewAppCreation } from '../api';
import { ago, Alert, DesktopOnly, PageHeader, Skeleton } from '../components/ui';
import { GithubGap, GithubNeeded } from '../components/GithubNeeded';

const err = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong.');
const code = (e: unknown) => (e instanceof ApiError ? e.code : undefined);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '').slice(0, 31);
const STEPS = ['Repository', 'Where', 'Review', 'Create'] as const;
const RUN_STEPS: [string, string][] = [['checks', 'Checks'], ['port', 'Pick a port'], ['clone', 'Clone the repository'], ['database', 'Database'],
  ['settings', 'Settings'], ['service', 'Service'], ['nginx', 'Web server'], ['https', 'HTTPS certificate'], ['deploy', 'Install, build, start'], ['done', 'Live']];

function Stepper({ step }: { step: number }) {
  return (
    <ol className="mb-6 flex items-center gap-2 text-sm">
      {STEPS.map((s, i) => (
        <li key={s} className="flex items-center gap-2">
          <span className={`grid h-6 w-6 place-items-center rounded-full border text-xs ${i < step ? 'border-emerald-400/50 bg-emerald-500/15 text-emerald-300' : i === step ? 'border-indigo-400 bg-indigo-500/20 text-indigo-100' : 'border-ink-600 text-slate-500'}`}>
            {i < step ? '✓' : i + 1}
          </span>
          <span className={i === step ? 'text-slate-100' : 'text-slate-500'}>{s}</span>
          {i < STEPS.length - 1 && <span className="mx-1 h-px w-8 bg-ink-600" />}
        </li>
      ))}
    </ol>
  );
}

function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return <div><span className="label">{label}</span>{children}{hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}</div>;
}

export function NewApp() {
  const instanceId = Number(useParams().id);
  const [search, setSearch] = useSearchParams();
  const jobParam = Number(search.get('job')) || null;
  const [history, setHistory] = useState<NewAppCreation[] | null>(null);
  /** The saved record behind a resumed job (after a refresh the form fields are empty). */
  const [creation, setCreation] = useState<NewAppCreation | null>(null);
  const [inst, setInst] = useState<Instance | null>(null);
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [ghError, setGhError] = useState<string | null>(null);
  const [ghGap, setGhGap] = useState<{ gap: GithubGap; installUrl: string | null } | null>(null);
  const [ghChecking, setGhChecking] = useState(false);
  const [step, setStep] = useState(0);
  // step 1
  // "Try again" from a failed creation opens the wizard pre-filled (?repo=&branch=&project=&subdomain=)
  const [repo, setRepo] = useState(search.get('repo') ?? '');
  const [branches, setBranches] = useState<string[]>([]);
  const [branch, setBranch] = useState(search.get('branch') || 'main');
  const [subdir, setSubdir] = useState('');
  const [det, setDet] = useState<Detection | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [start, setStart] = useState('start');
  const [build, setBuild] = useState(false);
  const [migrate, setMigrate] = useState('');
  const [healthPath, setHealthPath] = useState('/');
  const [frontendAck, setFrontendAck] = useState(false);
  // Python apps
  const [runtime, setRuntime] = useState<AppRuntime>('node');
  const [framework, setFramework] = useState<PyFramework | ''>('');
  const [appModule, setAppModule] = useState('');
  const [pyVersion, setPyVersion] = useState('3.12');
  // step 2
  const [project, setProject] = useState(search.get('project') ?? '');
  const [subdomain, setSubdomain] = useState(search.get('subdomain') ?? '');
  const [db, setDb] = useState(false);
  const [memoryMb, setMemoryMb] = useState(256);
  const [chk, setChk] = useState<NewAppCheck | null>(null);
  const [confirmLow, setConfirmLow] = useState(false);
  const [override, setOverride] = useState('');
  const [needOverride, setNeedOverride] = useState(false);
  // step 3/4
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<Deployment | null>(null);
  const started = useRef<number>(0);
  const [now, setNow] = useState(Date.now());

  // Resume: ?job=<id> reopens the live progress of a creation (refresh, reconnect, bookmark).
  useEffect(() => {
    api.newAppHistory(instanceId).then((h) => {
      setHistory(h);
      if (!jobParam) return;
      const c = h.find((x) => x.deploymentId === jobParam) ?? null;
      setCreation(c);
      api.deployment(jobParam).then((d) => { setJob(d); setStep(3); }).catch((e) => setError(err(e)));
    }).catch(() => setHistory([]));
  }, [instanceId, jobParam]);

  useEffect(() => {
    api.instance(instanceId).then((r) => setInst(r.instance)).catch((e) => setError(err(e)));
    void checkGithub();
  }, [instanceId]);   // eslint-disable-line react-hooks/exhaustive-deps

  /** Is GitHub ready to pick a repository? If not, which step is missing (shown as its own screen). */
  async function checkGithub(fresh = false) {
    setGhChecking(true); setGhError(null);
    try {
      const s = await api.github();
      if (!s.connected) { setGhGap({ gap: 'not_connected', installUrl: null }); return; }
      if (s.error) { setGhGap(null); setGhError(s.error); return; }
      if (!s.installations?.length) { setGhGap({ gap: 'not_installed', installUrl: s.installUrl ?? null }); return; }
      const list = await api.githubRepos(fresh);
      setRepos(list);
      setGhGap(list.length ? null : { gap: 'no_repos', installUrl: s.installUrl ?? null });
    } catch (e) { setGhError(err(e)); } finally { setGhChecking(false); }
  }

  useEffect(() => {
    if (!repo) return;
    api.githubBranches(repo).then(setBranches).catch(() => setBranches([]));
    const name = slug(repo.split('/')[1] ?? '');
    setProject((p) => p || name); setSubdomain((s) => s || name);
  }, [repo]);

  useEffect(() => {
    if (!repo || !branch) return;
    setDetecting(true);
    const t = setTimeout(() => {
      api.detectRepo(repo, branch, subdir).then((d) => {
        setDet(d); setFrontendAck(false);
        setStart(d.start ?? '');   // no start script: make the person choose one, never guess silently
        setBuild(d.build); setMigrate(d.migrate ?? ''); setHealthPath(d.healthPath || '/');
        setRuntime(d.runtime === 'python' ? 'python' : 'node');
        if (d.python) { setFramework(d.python.framework ?? ''); setAppModule(d.python.module ?? ''); setPyVersion(d.python.version); }
        if (d.runtime === 'python') { setMigrate(d.python?.migrate ?? ''); setBuild(false); }
      }).catch((e) => setDet({ found: false, name: null, scripts: [], start: null, build: false, migrate: null, healthPath: '/', node: null, warnings: [err(e)] }))
        .finally(() => setDetecting(false));
    }, 400);
    return () => clearTimeout(t);
  }, [repo, branch, subdir]);

  useEffect(() => {
    if (step !== 1 || !project || !subdomain) return;
    const t = setTimeout(() => { api.newAppCheck(instanceId, project, subdomain).then(setChk).catch((e) => setError(err(e))); }, 350);
    return () => clearTimeout(t);
  }, [step, project, subdomain, instanceId]);

  // follow the job
  useEffect(() => {
    if (!job || job.status !== 'running') return;
    const t = setInterval(async () => {
      setNow(Date.now());
      try { setJob(await api.deployment(job.id)); } catch { /* keep polling */ }
    }, 4000);
    return () => clearInterval(t);
  }, [job]);

  const summary = useMemo(() => {
    const line = (job?.output ?? '').trim().split('\n').reverse().find((l) => l.startsWith('{') && l.includes('"step"'));
    try { return line ? JSON.parse(line) as { ok: boolean; step: string; error: string | null; port: number | null; tls: boolean; database: string | null; domain: string } : null; } catch { return null; }
  }, [job]);

  if (error && !inst) return <Alert>{error}</Alert>;
  if (!inst) return <Skeleton className="h-64" />;

  const MODULE_RE = /^[A-Za-z_][A-Za-z0-9_.]{0,80}:[A-Za-z_][A-Za-z0-9_]{0,60}(\(\))?$/;
  const pyServer = framework === 'fastapi' ? 'uvicorn' : 'gunicorn';
  const step1Ok = !!repo && !!branch && !!det?.found && (runtime === 'python'
    ? !!framework && MODULE_RE.test(appModule) && !!pyVersion
    : !!start && (!det?.frontend || frontendAck));
  // switching runtime (a repository with both): each runtime's own migration choices
  const switchRuntime = (r: AppRuntime) => {
    setRuntime(r);
    if (r === 'python') { setMigrate(det?.python?.migrate ?? ''); setBuild(false); } else { setMigrate(det?.migrate ?? ''); setBuild(!!det?.build); }
  };
  const step2Ok = !!chk && chk.project.ok && (chk.domain.status === 'free' || chk.domain.status === 'ours' || chk.domain.status === 'external') && (chk.memoryMb == null || chk.memoryMb >= 120 || confirmLow);
  const domain = chk?.domain.name ?? `${subdomain}.${chk?.appsDomain ?? '…'}`;
  const scripts = det?.scripts ?? [];

  async function create() {
    setBusy(true); setError(null);
    try {
      const d = await api.createApp(instanceId, { project, repo, branch, subdir, start, build, migrate, healthPath, subdomain, db, memoryMb,
        confirmLowMemory: confirmLow, override: needOverride ? override : undefined,
        runtime, ...(runtime === 'python' ? { pythonVersion: pyVersion, framework, appModule } : {}) });
      started.current = Date.now(); setJob(d); setStep(3);
      setSearch({ job: String(d.id) }, { replace: true });   // a refresh comes back to this progress view
    } catch (e) {
      if (code(e) === 'frozen') setNeedOverride(true);
      setError(err(e));
    } finally { setBusy(false); }
  }

  return (
    <div>
      <div className="mb-2 text-xs text-slate-500"><Link to="/instances" className="hover:text-slate-300">Instances</Link> / <Link to={`/instances/${inst.id}`} className="hover:text-slate-300">{inst.name}</Link> / <span className="text-slate-400">New app</span></div>
      <PageHeader title="New app from GitHub" subtitle={`On ${inst.name} (${inst.region}) · Node.js apps`} />
      <DesktopOnly title="Creating apps" />
      <div className="hidden md:block">
        {step === 0 && ghGap ? (
          <GithubNeeded gap={ghGap.gap} installUrl={ghGap.installUrl} backTo={`/instances/${inst.id}`} refreshing={ghChecking} onRefresh={() => void checkGithub(true)} />
        ) : <>
        <Stepper step={step} />
        {ghError && <div className="mb-4"><Alert tone="warn">GitHub couldn&rsquo;t be read: {ghError}</Alert></div>}

        {step === 0 && (
          <section className="card space-y-5">
            <div className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
              <Field label="Repository" hint="Only repositories the GitHub App can see are listed.">
                <select className="input" value={repo} onChange={(e) => { setRepo(e.target.value); setDet(null); const r = repos?.find((x) => x.fullName === e.target.value); if (r) setBranch(r.defaultBranch); }}>
                  <option value="">{repos ? 'Choose a repository…' : 'Loading…'}</option>
                  {repos?.map((r) => <option key={r.fullName} value={r.fullName}>{r.fullName}{r.private ? ' (private)' : ''}</option>)}
                </select>
              </Field>
              <Field label="Branch" hint="Pushes to it deploy automatically.">
                <select className="input" value={branch} onChange={(e) => setBranch(e.target.value)}>
                  {(branches.length ? branches : [branch]).map((b) => <option key={b}>{b}</option>)}
                </select>
              </Field>
              <Field label="App folder (optional)" hint="If package.json isn't at the root, e.g. backend">
                <input className="input font-mono" value={subdir} onChange={(e) => setSubdir(e.target.value.replace(/^\/+/, ''))} placeholder="(root)" />
              </Field>
            </div>
            {repo && (
              <div className="rounded-lg border border-ink-700 p-4">
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-sm font-medium text-slate-200">
                    {detecting || !det ? 'Checking the repository…' : !det.found ? 'Nothing detected' : `Detected from ${runtime === 'python' ? (det.python?.deps ?? 'the repository') : 'package.json'}`}
                  </span>
                  <span className="flex items-center gap-2">
                    {det?.found && det.python && det.scripts.length > 0 && (
                      <span className="flex rounded-lg border border-ink-600 p-0.5 text-xs" role="radiogroup" aria-label="Runtime">
                        {(['node', 'python'] as const).map((r) => <button key={r} type="button" role="radio" aria-checked={runtime === r} onClick={() => switchRuntime(r)}
                          className={`rounded-md px-2 py-0.5 ${runtime === r ? 'bg-indigo-500/20 text-indigo-200' : 'text-slate-400 hover:text-slate-200'}`}>{r === 'node' ? 'Node.js' : 'Python'}</button>)}
                      </span>
                    )}
                    {detecting ? null : det?.found ? <span className="pill-ok">{runtime === 'python' ? `Python${framework ? ` · ${{ fastapi: 'FastAPI', flask: 'Flask', django: 'Django' }[framework]}` : ''}` : det.name ?? 'Node.js app'}</span> : det ? <span className="pill-bad">not found</span> : null}
                  </span>
                </div>
                {det?.found && runtime === 'python' && (
                  <div className="grid gap-4 md:grid-cols-4">
                    <Field label="Framework" hint={framework ? `Runs with ${pyServer}` : 'How the app is served'}>
                      <select className={`input ${framework ? '' : 'border-amber-500/60'}`} value={framework} onChange={(e) => { const f = e.target.value as PyFramework | ''; setFramework(f); if (f !== 'django') { setBuild(false); if (migrate === 'django') setMigrate(''); } }}>
                        <option value="">Choose…</option><option value="fastapi">FastAPI (uvicorn)</option><option value="flask">Flask (gunicorn)</option><option value="django">Django (gunicorn)</option>
                      </select>
                    </Field>
                    <Field label="App module" hint={framework === 'django' ? 'e.g. mysite.wsgi:application' : framework === 'flask' ? 'e.g. app:app or app:create_app()' : 'e.g. app.main:app'}>
                      <input className={`input font-mono ${appModule && !MODULE_RE.test(appModule) ? 'border-rose-500/60' : !appModule ? 'border-amber-500/60' : ''}`} value={appModule} spellCheck={false} onChange={(e) => setAppModule(e.target.value.trim())} placeholder="package.module:app" />
                    </Field>
                    <Field label="Python version" hint="Installed on the server if missing">
                      <select className="input" value={pyVersion} onChange={(e) => setPyVersion(e.target.value)}>{['3.11', '3.12', '3.13'].map((v) => <option key={v}>{v}</option>)}</select>
                    </Field>
                    <Field label="Database migrations" hint="Run on every deploy">
                      <select className="input" value={migrate} onChange={(e) => setMigrate(e.target.value)}>
                        <option value="">none</option><option value="alembic">Alembic (alembic upgrade head)</option>{framework === 'django' && <option value="django">Django (manage.py migrate)</option>}
                      </select>
                    </Field>
                    {framework === 'django' && <Field label="Static files"><label className="mt-2 flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" className="accent-indigo-400" checked={build} onChange={(e) => setBuild(e.target.checked)} /> manage.py collectstatic</label></Field>}
                    <Field label="Health check path" hint="Must answer 200 once the app is up">
                      <input className="input font-mono" value={healthPath} onChange={(e) => setHealthPath(e.target.value.startsWith('/') ? e.target.value : `/${e.target.value}`)} />
                    </Field>
                  </div>
                )}
                {det?.found && runtime === 'node' && (
                  <div className="grid gap-4 md:grid-cols-4">
                    <Field label="Start with" hint={!start ? 'Pick the script that starts the server' : start === 'start' ? 'npm start' : `npm run ${start}`}>
                      <select className={`input ${start ? '' : 'border-amber-500/60'}`} value={start} onChange={(e) => setStart(e.target.value)}><option value="">Choose a script…</option>{scripts.map((s) => <option key={s}>{s}</option>)}</select>
                    </Field>
                    <Field label="Build step"><label className="mt-2 flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" className="accent-indigo-400" checked={build} onChange={(e) => setBuild(e.target.checked)} disabled={!scripts.includes('build')} /> npm run build</label></Field>
                    <Field label="Database migrations" hint="Run on every deploy">
                      <select className="input" value={migrate} onChange={(e) => setMigrate(e.target.value)}><option value="">none</option>{scripts.map((s) => <option key={s}>{s}</option>)}</select>
                    </Field>
                    <Field label="Health check path" hint="Must answer 200 once the app is up">
                      <input className="input font-mono" value={healthPath} onChange={(e) => setHealthPath(e.target.value.startsWith('/') ? e.target.value : `/${e.target.value}`)} />
                    </Field>
                  </div>
                )}
                {det?.warnings.map((w) => <p key={w} className="mt-3 text-sm text-amber-300">{w}</p>)}
                {runtime === 'node' && det?.frontend && (
                  <label className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-3 text-sm text-amber-100">
                    <input type="checkbox" className="mt-0.5 accent-amber-400" checked={frontendAck} onChange={(e) => setFrontendAck(e.target.checked)} />
                    <span>I know this app has its own server (or I picked a script that serves it) and want to continue anyway.</span>
                  </label>
                )}
              </div>
            )}
            <div className="flex justify-end"><button className="btn-primary" disabled={!step1Ok} onClick={() => setStep(1)}>Next</button></div>
          </section>
        )}

        {step === 1 && (
          <section className="card space-y-5">
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="App name" hint={chk && !chk.project.ok ? <span className="text-rose-300">{chk.project.reason}</span> : 'Used for the service, folder and database.'}>
                <input className="input font-mono" value={project} onChange={(e) => setProject(slug(e.target.value))} maxLength={31} />
              </Field>
              <Field label="Address" hint={chk ? <span className={chk.domain.status === 'free' || chk.domain.status === 'ours' ? 'text-emerald-300' : chk.domain.status === 'external' ? 'text-slate-400' : 'text-rose-300'}>
                {chk.domain.status === 'free' ? `${chk.domain.name} is available; DNS is set up automatically.` : chk.domain.status === 'ours' ? `${chk.domain.name} already points at this server.` : chk.domain.reason}
              </span> : 'Checking…'}>
                <div className="flex items-center gap-2">
                  <input className="input font-mono" value={subdomain} onChange={(e) => setSubdomain(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} maxLength={63} />
                  <span className="shrink-0 text-sm text-slate-400">.{chk?.appsDomain ?? '…'}</span>
                </div>
              </Field>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-ink-700 p-4">
                <input type="checkbox" className="mt-1 accent-indigo-400" checked={db} onChange={(e) => setDb(e.target.checked)} />
                <span><span className="block text-sm font-medium text-slate-200">Create a Postgres database</span>
                  <span className="block text-xs text-slate-500">Its own database and user on this instance; DATABASE_URL is added to the app's environment automatically. Included in nightly backups.</span></span>
              </label>
              <Field label="Memory limit" hint={chk?.memoryMb != null ? `${chk.memoryMb} MB free on ${inst.name} right now.` : undefined}>
                <select className="input" value={memoryMb} onChange={(e) => setMemoryMb(Number(e.target.value))}>{[128, 192, 256, 384, 512].map((m) => <option key={m} value={m}>{m} MB</option>)}</select>
              </Field>
            </div>
            {chk?.memoryWarning && <Alert tone="warn">{chk.memoryWarning}</Alert>}
            {chk && chk.memoryMb != null && chk.memoryMb < 120 && (
              <label className="flex items-center gap-2 text-sm text-amber-200"><input type="checkbox" className="accent-amber-400" checked={confirmLow} onChange={(e) => setConfirmLow(e.target.checked)} /> I understand; create it anyway.</label>
            )}
            <div className="flex justify-between"><button className="btn-ghost" onClick={() => setStep(0)}>Back</button><button className="btn-primary" disabled={!step2Ok} onClick={() => setStep(2)}>Next</button></div>
          </section>
        )}

        {step === 2 && (
          <section className="card space-y-5">
            <table className="tbl"><tbody>
              {([['Repository', `${repo} · ${branch}${subdir ? ` · ${subdir}/` : ''}`],
                ['Runs', runtime === 'python' ? `${pyServer} ${appModule} (Python ${pyVersion}, its own virtual environment)${build ? ' after collectstatic' : ''}` : `${start === 'start' ? 'npm start' : `npm run ${start}`}${build ? ' after npm run build' : ''}`],
                ['Migrations', !migrate ? 'none' : runtime === 'python' ? `${migrate === 'alembic' ? 'alembic upgrade head' : 'manage.py migrate'} on every deploy` : `npm run ${migrate} on every deploy`], ['Address', `https://${domain}`], ['Database', db ? `Postgres database ${project.replace(/-/g, '_')}` : 'none'],
                ['Memory limit', `${memoryMb} MB`], ['Deploys', `automatically on every push to ${branch}`], ['Instance', `${inst.name} (${inst.region}, ${inst.environment})`]] as [string, string][]).map(([k, v]) => (
                <tr key={k}><td className="w-[22%] text-slate-500">{k}</td><td className="text-slate-200" title={v}>{v}</td></tr>
              ))}
            </tbody></table>
            <p className="text-sm text-slate-400">This clones the repository onto {inst.name}, creates the service, {db ? 'the database, ' : ''}the web address and its HTTPS certificate, then runs the first deploy. It takes a few minutes. If any step fails, everything it created is removed again.</p>
            {needOverride && (
              <Field label="Deploys are frozen: reason for creating the app anyway (logged and announced)">
                <input className="input" value={override} onChange={(e) => setOverride(e.target.value)} maxLength={300} />
              </Field>
            )}
            {error && <Alert>{error}</Alert>}
            <div className="flex justify-between">
              <button className="btn-ghost" onClick={() => setStep(1)} disabled={busy}>Back</button>
              <button className="btn-primary" onClick={() => void create()} disabled={busy || (needOverride && override.trim().length < 10)}>{busy ? 'Starting…' : 'Create app'}</button>
            </div>
          </section>
        )}

        {step === 0 && !jobParam && (() => {
          const running = history?.filter((c) => c.status === 'running' && c.deploymentId) ?? [];
          return running.length > 0 && (
            <div className="mb-5 space-y-2">
              {running.map((c) => (
                <div key={c.id} className="card flex flex-wrap items-center gap-3 border-indigo-400/40 bg-indigo-500/[0.07] p-4">
                  <span className="h-3 w-3 animate-pulse rounded-full bg-indigo-400 motion-reduce:animate-none" />
                  <span className="min-w-0 flex-1 truncate text-sm text-slate-200"><b>{c.project}</b> is being created ({c.repo}@{c.branch} → {c.domain}) · started by {c.createdBy} {ago(c.createdAt)}</span>
                  <Link className="btn-primary px-3 py-1.5 text-xs" to={`?job=${c.deploymentId}`}>View progress</Link>
                </div>
              ))}
            </div>
          );
        })()}

        {step === 3 && job && (
          <section className="card space-y-5">
            <div className="flex items-center gap-3">
              {job.status === 'running' ? <span className="h-3 w-3 animate-pulse rounded-full bg-indigo-400 motion-reduce:animate-none" /> : job.status === 'success' ? <span className="pill-ok">live</span> : <span className="pill-bad">failed</span>}
              <h2 className="font-medium text-slate-100">{job.status === 'running' ? `Creating ${creation?.project ?? project}…` : job.status === 'success' ? `${creation?.project ?? project} is live` : `Creating ${creation?.project ?? project} failed`}</h2>
              <span className="ml-auto text-xs text-slate-500">{Math.round(((job.finishedAt ? Date.parse(job.finishedAt) : now) - Date.parse(job.createdAt)) / 1000)}s</span>
            </div>
            <ol className="grid gap-2 md:grid-cols-2">
              {RUN_STEPS.filter(([k]) => k !== 'database' || (creation ? creation.withDb : db)).map(([k, label]) => {
                const order = RUN_STEPS.map(([x]) => x);
                const reached = summary ? order.indexOf(summary.step) : -1;
                const state = job.status === 'success' ? 'done' : summary && !summary.ok ? (order.indexOf(k) < reached ? 'done' : k === summary.step ? 'failed' : 'skipped') : 'pending';
                return (
                  <li key={k} className="flex items-center gap-2 text-sm">
                    <span className={`grid h-5 w-5 place-items-center rounded-full text-[10px] ${state === 'done' ? 'bg-emerald-500/20 text-emerald-300' : state === 'failed' ? 'bg-rose-500/20 text-rose-300' : 'bg-ink-700 text-slate-500'}`}>
                      {state === 'done' ? '✓' : state === 'failed' ? '✕' : '·'}
                    </span>
                    <span className={state === 'failed' ? 'text-rose-200' : state === 'done' ? 'text-slate-200' : 'text-slate-500'}>{label}</span>
                  </li>
                );
              })}
            </ol>
            {job.status === 'running' && <p className="text-sm text-slate-400">This usually takes 2–5 minutes. This page can be left or refreshed: progress is kept (the address of this page reopens it), and the result also arrives by email. The steps fill in when the run finishes.</p>}
            {job.status === 'success' && (
              <Alert tone="ok">
                <a className="underline" href={`https://${summary?.domain ?? creation?.domain ?? domain}`} target="_blank" rel="noreferrer noopener">https://{summary?.domain ?? creation?.domain ?? domain}</a>
                {summary && !summary.tls ? ' (HTTPS pending: DNS was still propagating)' : ''}. Pushes to {creation?.branch ?? branch} now deploy automatically. The app page appears within a few minutes.
              </Alert>
            )}
            {job.status === 'failed' && <Alert>{summary?.error ?? 'The run failed.'} Everything it created was removed again.</Alert>}
            {job.output && <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap break-all rounded-lg bg-ink-950 p-3 font-mono text-[12px] leading-5 text-slate-300">{job.output}</pre>}
            {job.status !== 'running' && (
              <div className="flex gap-2">
                <Link to={`/instances/${inst.id}`} className="btn-secondary">Back to {inst.name}</Link>
                {job.status === 'success' && <Link to={`/instances/${inst.id}/apps/${creation?.project ?? project}`} className="btn-primary">Open {creation?.project ?? project}</Link>}
                {job.status === 'failed' && <button className="btn-primary" onClick={() => { setJob(null); setCreation(null); setSearch({}, { replace: true }); setStep(creation ? 0 : 2); }}>Try again</button>}
              </div>
            )}
          </section>
        )}
        {step === 0 && !jobParam && history && history.length > 0 && (
          <section className="card mt-5 overflow-hidden p-0">
            <h2 className="px-5 py-4 font-medium text-slate-100">Recent new apps on {inst.name}</h2>
            <table className="tbl">
              <thead><tr><th className="w-[18%]">App</th><th>Repository</th><th className="w-[26%]">Address</th><th className="w-[12%]">Status</th><th className="w-[12%]">Started</th><th className="w-[12%] text-right"></th></tr></thead>
              <tbody>{history.slice(0, 8).map((c) => (
                <tr key={c.id}>
                  <td className="font-medium text-slate-100">{c.project}</td>
                  <td className="num text-xs" title={`${c.repo}@${c.branch}`}>{c.repo}@{c.branch}</td>
                  <td title={c.domain}>{c.domain}</td>
                  <td><span className={c.status === 'success' ? 'pill-ok' : c.status === 'failed' ? 'pill-bad' : 'pill-info'}>{c.status === 'running' ? 'creating' : c.status === 'success' ? 'live' : 'failed'}</span></td>
                  <td title={c.createdAt}>{ago(c.createdAt)}</td>
                  <td className="text-right">{c.deploymentId && <Link className="btn-ghost px-2 py-1 text-xs" to={`?job=${c.deploymentId}`}>{c.status === 'running' ? 'Progress' : 'Details'}</Link>}</td>
                </tr>
              ))}</tbody>
            </table>
          </section>
        )}
        </>}
      </div>
    </div>
  );
}
