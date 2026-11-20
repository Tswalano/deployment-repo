import { FormEvent, useEffect, useState } from 'react';
import { api, ApiError, Instance } from '../api';
import { useAuth } from '../auth';
import { Alert, DesktopOnly, Dot, PageHeader, ago } from '../components/ui';
import { AlertSettingsForm } from '../components/AlertSettingsForm';
import { CostCurrencyForm } from '../components/CostCurrencyForm';
import { DeployPolicyForm } from '../components/DeployPolicyForm';
import { GithubConnect } from '../components/GithubConnect';
import { WorkspaceForm } from '../components/WorkspaceForm';
import { AwsAccountCard } from '../components/ConnectAws';
import { AppsDomainCard } from '../components/AppsDomainCard';
import { usePoll } from '../usePoll';
import { useDialog } from '../components/Dialog';

const REGIONS = ['af-south-1', 'eu-west-1', 'eu-central-1', 'us-east-1', 'us-west-2', 'ap-southeast-1'];
const ENVS = ['production', 'staging', 'development'];
const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong.');

function AddInstance({ onAdded }: { onAdded: (i: Instance) => void }) {
  const [form, setForm] = useState({ awsInstanceId: '', region: 'af-south-1', name: '', environment: 'production' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const i = await api.addInstance(form);
      setForm({ ...form, awsInstanceId: '', name: '' });
      onAdded(i);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card space-y-4">
      <div>
        <h2 className="font-medium text-slate-100">Add an EC2 instance</h2>
        <p className="mt-1 text-sm text-slate-500">
          The instance must be running, reachable by SSM (agent + an instance profile with AmazonSSMManagedInstanceCore),
          and tagged <code className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-xs text-slate-300">ops-console = managed</code>.
          The console only ever runs its own fixed SSM documents on it.
        </p>
      </div>
      <div className="grid gap-3 lg:grid-cols-[1.3fr_1fr_1.2fr_1fr_auto] lg:items-end">
        <div>
          <label className="label" htmlFor="ai-id">Instance ID</label>
          <input id="ai-id" className="input font-mono" placeholder="i-0123456789abcdef0" required pattern="i-[0-9a-f]{8,17}"
                 value={form.awsInstanceId} onChange={(e) => setForm({ ...form, awsInstanceId: e.target.value.trim() })} />
        </div>
        <div>
          <label className="label" htmlFor="ai-region">Region</label>
          <select id="ai-region" className="input" value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })}>
            {REGIONS.map((r) => <option key={r}>{r}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="ai-name">Display name <span className="text-slate-600">(optional)</span></label>
          <input id="ai-name" className="input" placeholder="uses the Name tag" maxLength={60}
                 value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div>
          <label className="label" htmlFor="ai-env">Environment</label>
          <select id="ai-env" className="input capitalize" value={form.environment} onChange={(e) => setForm({ ...form, environment: e.target.value })}>
            {ENVS.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </div>
        <button className="btn-primary" disabled={busy || !/^i-[0-9a-f]{8,17}$/.test(form.awsInstanceId)}>
          {busy ? 'Checking via AWS…' : 'Add instance'}
        </button>
      </div>
      {error && <Alert>{error}</Alert>}
    </form>
  );
}

export function Settings() {
  const { site } = useAuth();
  const dialog = useDialog();
  const { data, error, reload } = usePoll(api.instances, 60_000);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (!['alerts', 'policy', 'github', 'addresses'].includes(id)) return;
    const t = setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }), 400);
    return () => clearTimeout(t);
  }, []);
  const [actionError, setActionError] = useState<string | null>(null);

  async function act(fn: () => Promise<unknown>, done: string) {
    setNotice(null);
    setActionError(null);
    try {
      await fn();
      setNotice(done);
      await reload();
    } catch (err) {
      setActionError(errMsg(err));
    }
  }

  return (
    <div>
      <PageHeader title="Settings" subtitle="Monitored instances, alerting and notifications" />
      <DesktopOnly title="Settings" />
      <div className="hidden space-y-5 md:block">
        <AddInstance onAdded={(i) => { setNotice(`${i.name} added${i.lastError ? `, but the first snapshot failed: ${i.lastError}` : '.'}`); void reload(); }} />
        {notice && <Alert tone="ok">{notice}</Alert>}
        {(actionError || error) && <Alert>{actionError || error}</Alert>}
        <section className="card overflow-hidden p-0">
          <h2 className="px-5 py-4 font-medium text-slate-100">Managed instances</h2>
          <table className="tbl">
            <thead><tr>
              <th className="w-[22%]">Name</th><th className="w-[20%]">Instance</th><th className="w-[12%]">Region</th>
              <th className="w-[13%]">Environment</th><th className="w-[15%]">Last snapshot</th><th className="text-right">Actions</th>
            </tr></thead>
            <tbody>
              {data === null && <tr><td colSpan={6} className="text-slate-500">Loading…</td></tr>}
              {data?.length === 0 && <tr><td colSpan={6} className="text-slate-500">None yet. Add one above.</td></tr>}
              {data?.map((i) => (
                <tr key={i.id}>
                  <td title={i.name}><div className="flex items-center gap-2"><Dot tone={i.lastError ? 'bad' : i.status ? 'ok' : 'mute'} /><span className="truncate font-medium text-slate-100">{i.name}</span></div></td>
                  <td className="num text-xs" title={i.awsInstanceId}>{i.awsInstanceId}</td>
                  <td>{i.region}</td>
                  <td>
                    <select aria-label={`Environment for ${i.name}`} className="input py-1 capitalize" value={i.environment}
                            onChange={(e) => void act(() => api.updateInstance(i.id, { environment: e.target.value }), `${i.name} is now ${e.target.value}.`)}>
                      {ENVS.map((x) => <option key={x} value={x}>{x}</option>)}
                    </select>
                  </td>
                  <td title={i.lastError ?? i.lastOkAt ?? ''} className={i.lastError ? 'text-rose-300' : ''}>{i.lastError ? 'failing' : ago(i.lastOkAt)}</td>
                  <td className="text-right">
                    <div className="flex justify-end gap-2">
                      <button className="btn-secondary px-2.5 py-1 text-xs" onClick={async () => {
                        const name = await dialog.prompt({ title: `Rename ${i.name}`, body: 'Only the name shown in the console changes; the EC2 instance is not touched.',
                          label: 'Display name', defaultValue: i.name, minLength: 1, maxLength: 60, confirmLabel: 'Rename' });
                        if (name && name !== i.name) void act(() => api.updateInstance(i.id, { name }), `Renamed to ${name}.`);
                      }}>Rename</button>
                      <button className="btn-danger px-2.5 py-1 text-xs" onClick={async () => {
                        if (await dialog.confirm({ title: `Stop monitoring ${i.name}?`, body: 'The EC2 instance itself is not touched; only its history in the console is removed.', confirmLabel: 'Remove from the console', danger: true })) {
                          void act(() => api.removeInstance(i.id), `${i.name} removed from the console.`);
                        }
                      }}>Remove</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        {site.multiTenant && <WorkspaceForm />}
        {site.multiTenant && <AwsAccountCard />}
        {site.multiTenant && <AppsDomainCard />}
        <GithubConnect />
        <DeployPolicyForm />
        <AlertSettingsForm />
        <CostCurrencyForm />
      </div>
    </div>
  );
}
