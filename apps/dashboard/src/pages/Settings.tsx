import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { useTitle } from '../hooks';
import {
  Button,
  Card,
  Confirm,
  ErrorBanner,
  Field,
  PageHeader,
  Skeleton,
  errorMessage,
  useToast,
} from '../ui';

interface TenantInfo {
  tenant: { id: string; name: string; plan: string; slug: string };
  role: string;
}
const PLANS = ['free', 'pro', 'business', 'selfhost'] as const;

export function Settings() {
  useTitle('Settings');
  const auth = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState<string | null>(null);
  const [plan, setPlan] = useState<string | null>(null);
  const [del, setDel] = useState(false);
  const tid = auth.active?.tenantId;
  const q = useQuery({
    queryKey: ['tenant', tid],
    queryFn: () => api<TenantInfo>('GET', '/tenant'),
  });
  const role = auth.active?.role;
  const save = useMutation({
    mutationFn: (body: { name?: string; plan?: string }) => api('PATCH', '/tenant', body),
    onSuccess: () => {
      toast('ok', 'Saved');
      void qc.invalidateQueries();
      setName(null);
      setPlan(null);
    },
    onError: (e) => toast('error', errorMessage(e)),
  });

  if (q.isLoading)
    return (
      <>
        <PageHeader title="Settings" />
        <Skeleton />
      </>
    );
  if (q.error || !q.data)
    return (
      <>
        <PageHeader title="Settings" />
        <ErrorBanner error={q.error} retry={() => void q.refetch()} />
      </>
    );
  const t = q.data.tenant;
  const canRename = role === 'owner' || role === 'admin';
  return (
    <>
      <PageHeader title="Settings" />
      <Card title="Organization">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name !== null) save.mutate({ name });
          }}
        >
          <Field
            label="Name"
            value={name ?? t.name}
            onChange={(e) => setName(e.target.value)}
            disabled={!canRename}
            hint={`Slug: ${t.slug}`}
          />
          {canRename && (
            <Button
              type="submit"
              loading={save.isPending}
              disabled={name === null || name.trim() === ''}
            >
              Save
            </Button>
          )}
        </form>
      </Card>
      <Card title="Plan">
        <p className="mb-3 text-muted">
          Billing is simulated; changing the plan changes enforced quotas within a minute.
        </p>
        <div className="flex items-end gap-2">
          <div>
            <label htmlFor="plan" className="mb-1 block font-medium">
              Plan
            </label>
            <select
              id="plan"
              className="rounded-input border border-line bg-bg px-3 py-2"
              disabled={role !== 'owner'}
              value={plan ?? t.plan}
              onChange={(e) => setPlan(e.target.value)}
            >
              {PLANS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          {role === 'owner' ? (
            <Button
              loading={save.isPending}
              disabled={plan === null || plan === t.plan}
              onClick={() => plan && save.mutate({ plan })}
            >
              Change plan
            </Button>
          ) : (
            <p className="text-muted">Only the owner can change the plan.</p>
          )}
        </div>
      </Card>
      {role === 'owner' && (
        <Card title="Danger zone">
          <p className="mb-3 text-muted">
            Deleting the organization stops all keys and sessions immediately. Data is purged later.
          </p>
          <Button variant="danger" onClick={() => setDel(true)}>
            Delete organization
          </Button>
          {del && (
            <Confirm
              title="Delete this organization?"
              message="This cannot be undone from the dashboard."
              requireText={t.name}
              confirmLabel="Delete organization"
              onConfirm={async () => {
                await api('DELETE', '/tenant');
                await auth.logout();
              }}
              onClose={() => setDel(false)}
            />
          )}
        </Card>
      )}
    </>
  );
}
