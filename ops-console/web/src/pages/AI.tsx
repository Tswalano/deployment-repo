import { useEffect, useState } from 'react';
import { Navigate, NavLink, useParams } from 'react-router-dom';
import { api, AssistantAction, AssistantStatus } from '../api';
import { useAuth } from '../auth';
import { ActionCard } from '../components/ActionCard';
import { ProposalHistory } from '../components/ProposalHistory';
import { AssistantSettingsForm } from '../components/AssistantSettingsForm';
import { McpTokens } from '../components/McpTokens';
import { Alert, PageHeader } from '../components/ui';
import { ListChecks, MessageSquare, Plug } from 'lucide-react';
import { smallIcon } from '../components/icons';

/**
 * AI Console: everything about AI in one place.
 *   /ai/assistant  Ask Ops Console: open the chat; admins choose the provider, key and model
 *   /ai/mcp        the workspace MCP server: address, connectors, personal tokens, connected apps
 *   /ai/proposals  deploys, rollbacks and server actions proposed by AI, waiting for confirmation (and history)
 */
const TABS = [
  { slug: 'assistant', label: 'Ask Ops Console', icon: MessageSquare },
  { slug: 'mcp', label: 'MCP server', icon: Plug },
  { slug: 'proposals', label: 'Proposals', icon: ListChecks },
] as const;

export function openAsk() { window.dispatchEvent(new CustomEvent('ops:open-ask')); }

function AssistantTab() {
  const { user } = useAuth();
  const [st, setSt] = useState<AssistantStatus | null>(null);
  useEffect(() => { api.assistant().then(setSt).catch(() => setSt({ enabled: false })); }, []);
  return (
    <div className="space-y-5">
      <section className="card space-y-3">
        <h2 className="font-medium text-slate-100">Ask Ops Console</h2>
        <p className="text-sm text-slate-400">
          A chat that answers questions about this workspace from live data (servers, apps, deploys, alerts, uptime, backups and costs) and can prepare a deploy,
          rollback, or a server start or reboot for you to confirm. It opens as a floating window on every page.
        </p>
        {st?.enabled
          ? <div className="flex flex-wrap items-center gap-3"><button className="btn-primary" onClick={openAsk}>Open the chat</button><span className="text-xs text-slate-500">Uses {st.providerName} · {st.model}</span></div>
          : <Alert tone="warn">Not set up yet{user?.role === 'admin' ? ': choose a provider and add an API key below.' : ': a workspace admin can set it up here.'}</Alert>}
      </section>
      {user?.role === 'admin' && <AssistantSettingsForm />}
    </div>
  );
}

function ProposalsTab() {
  const { user } = useAuth();
  const [list, setList] = useState<AssistantAction[] | null>(null);
  const load = () => api.actions().then(setList).catch(() => setList([]));
  useEffect(() => { void load(); const t = setInterval(load, 20_000); return () => clearInterval(t); }, []);
  const open = list?.filter((a) => a.status === 'proposed') ?? [];
  const past = list?.filter((a) => a.status !== 'proposed') ?? [];
  return (
    <div className="space-y-5">
      <section className="card space-y-3">
        <h2 className="font-medium text-slate-100">Waiting for confirmation</h2>
        <p className="text-sm text-slate-400">Changes that Ask Ops Console or a connected AI tool prepared for you. Nothing happens unless you confirm, within 15 minutes; it then runs as you, with the usual approvals and freeze windows.</p>
        {list && !open.length && <p className="text-sm text-slate-500">Nothing is waiting.</p>}
        <div className="grid gap-3 md:grid-cols-2">{open.map((a) => <ActionCard key={a.id} action={a} onChange={() => void load()} />)}</div>
      </section>
      {past.length > 0 && (
        <section className="card space-y-3">
          <div>
            <h2 className="font-medium text-slate-100">History</h2>
            <p className="mt-1 text-sm text-slate-400">Proposals that were confirmed, cancelled or expired. Select a row for the detail.</p>
          </div>
          <ProposalHistory items={past} isAdmin={user?.role === 'admin'} />
        </section>
      )}
    </div>
  );
}

export function AI() {
  const { tab } = useParams();
  if (!TABS.some((t) => t.slug === tab)) return <Navigate to="/ai/assistant" replace />;
  return (
    <div>
      <PageHeader title="AI Console" subtitle="Ask Ops Console, the workspace MCP server, and changes AI has proposed" />
      <nav className="mb-5 flex gap-1 border-b border-ink-700" aria-label="AI Console">
        {TABS.map((t) => (
          <NavLink key={t.slug} to={`/ai/${t.slug}`}
                   className={({ isActive }) => `-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm ${isActive ? 'border-indigo-400 font-medium text-slate-100' : 'border-transparent text-slate-400 hover:text-slate-200'}`}>
            {smallIcon(t.icon)}{t.label}
          </NavLink>
        ))}
      </nav>
      {tab === 'assistant' && <AssistantTab />}
      {tab === 'mcp' && (
        <section className="card space-y-4">
          <div>
            <h2 className="font-medium text-slate-100">MCP server</h2>
            <p className="mt-1 text-sm text-slate-400">Connect ChatGPT, Claude, Cursor or VS Code to this workspace. They can read it with your role, and propose changes that you confirm under Proposals.</p>
          </div>
          <McpTokens />
        </section>
      )}
      {tab === 'proposals' && <ProposalsTab />}
    </div>
  );
}
