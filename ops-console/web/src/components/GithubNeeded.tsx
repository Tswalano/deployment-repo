import { Link } from 'react-router-dom';
import { useAuth } from '../auth';

export type GithubGap = 'not_connected' | 'not_installed' | 'no_repos';

const Mark = ({ className = 'h-6 w-6' }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
    <path d="M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.1c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.9 1.3 1.9 1.3 1.1 1.9 2.9 1.3 3.6 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 4.6 18.3 5 18.3 5c.7 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .5z" />
  </svg>
);

const COPY: Record<GithubGap, { title: string; body: string }> = {
  not_connected: {
    title: 'Connect GitHub to create apps',
    body: 'Apps are built and deployed from GitHub repositories. Connecting creates a private GitHub App in the chosen GitHub account, with read-only access to code, and every push to a linked branch then deploys automatically.',
  },
  not_installed: {
    title: 'Install the GitHub App on repositories',
    body: "GitHub is connected, but the app isn't installed on any account yet. Install it and choose which repositories the console may read.",
  },
  no_repos: {
    title: 'No repositories shared with the GitHub App',
    body: 'The app is installed, but it has no repositories it may read. Add at least one repository to its access on GitHub.',
  },
};

const STEPS: [string, string][] = [
  ['Connect GitHub', 'Settings → GitHub → Connect GitHub creates a private app in a GitHub account or organisation.'],
  ['Choose repositories', 'Install the app and pick the repositories it may read (read-only).'],
  ['Create the app', 'Come back here, choose a repository and branch, and the console builds and deploys it.'],
];

/** New app, when GitHub isn't ready yet: what's missing, why, and the one action that fixes it. */
export function GithubNeeded({ gap, installUrl, backTo, onRefresh, refreshing }:
  { gap: GithubGap; installUrl?: string | null; backTo: string; onRefresh: () => void; refreshing: boolean }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' && !user.isDemo;
  const done = gap === 'not_connected' ? 0 : 1;   // the step to do now
  return (
    <section className="card mx-auto max-w-2xl p-8">
      <div className="flex items-start gap-4">
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-ink-600 bg-ink-900 text-slate-200"><Mark /></span>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-slate-100">{COPY[gap].title}</h2>
          <p className="mt-1.5 text-sm leading-6 text-slate-400">{COPY[gap].body}</p>
        </div>
      </div>

      <ol className="mt-6 space-y-3">
        {STEPS.map(([title, text], i) => (
          <li key={title} className="flex gap-3">
            <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border text-xs ${i < done ? 'border-emerald-400/50 text-emerald-300' : i === done ? 'border-indigo-400/60 text-indigo-200' : 'border-ink-600 text-slate-500'}`}>
              {i < done ? '✓' : i + 1}
            </span>
            <div className={i === done ? '' : 'opacity-70'}>
              <div className="text-sm font-medium text-slate-200">{title}</div>
              <div className="text-xs text-slate-500">{text}</div>
            </div>
          </li>
        ))}
      </ol>

      <div className="mt-7 flex flex-wrap items-center gap-2 border-t border-ink-700 pt-5">
        {isAdmin ? (
          gap === 'not_connected'
            ? <Link to="/settings#github" className="btn-primary"><Mark className="h-4 w-4" />Connect GitHub</Link>
            : installUrl && <a href={installUrl} target="_blank" rel="noreferrer noopener" className="btn-primary"><Mark className="h-4 w-4" />{gap === 'not_installed' ? 'Install on GitHub' : 'Change repository access'}</a>
        ) : <p className="text-sm text-slate-400">An admin of this workspace connects GitHub (Settings → GitHub).</p>}
        {gap !== 'not_connected' && <button className="btn-ghost" disabled={refreshing} onClick={onRefresh}>{refreshing ? 'Checking…' : 'I’ve done this: refresh'}</button>}
        <Link to={backTo} className="btn-ghost ml-auto">Back to the server</Link>
      </div>
    </section>
  );
}
