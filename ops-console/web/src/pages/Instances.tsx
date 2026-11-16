import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { InstanceCard } from '../components/InstanceCard';
import { Alert, PageHeader, Skeleton } from '../components/ui';
import { usePoll } from '../usePoll';

export function Instances() {
  const { user } = useAuth();
  const { data, error } = usePoll(api.instances, 30_000);
  return (
    <div>
      <PageHeader
        title="Instances"
        subtitle={data ? `${data.length} EC2 instance${data.length === 1 ? '' : 's'} managed through AWS SSM` : 'Loading…'}
        actions={user?.role === 'admin' && <Link to="/settings" className="btn-secondary hidden md:inline-flex">Manage instances</Link>}
      />
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      {!data ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-44" />)}</div>
      ) : data.length === 0 ? (
        <div className="card py-12 text-center text-sm text-slate-500">No instances yet.{user?.role === 'admin' && <> Add one under <Link to="/settings" className="text-indigo-300 hover:underline">Settings</Link>.</>}</div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{data.map((i) => <InstanceCard key={i.id} instance={i} />)}</div>
      )}
    </div>
  );
}
