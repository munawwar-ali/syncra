import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { canWrite, isAdmin, useAuth } from '../auth';
import { useTitle } from '../hooks';
import {
  Button,
  Card,
  Confirm,
  EmptyState,
  ErrorBanner,
  Field,
  Modal,
  PageHeader,
  SecretModal,
  Skeleton,
  errorMessage,
  fmtTime,
  useToast,
} from '../ui';

interface Key {
  id: string;
  kind: 'secret' | 'publishable';
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export function Keys() {
  useTitle('API keys');
  const auth = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'secret' | 'publishable'>('publishable');
  const [secret, setSecret] = useState<string | null>(null);
  const [revoke, setRevoke] = useState<Key | null>(null);
  const [err, setErr] = useState<string>();
  const role = auth.active?.role;
  const q = useQuery({
    queryKey: ['keys', auth.active?.tenantId],
    queryFn: () => api<{ items: Key[] }>('GET', '/keys'),
  });
  const create = useMutation({
    mutationFn: () => api<Key & { key: string }>('POST', '/keys', { kind, name }),
    onSuccess: (r) => {
      setCreating(false);
      setName('');
      setSecret(r.key);
      void qc.invalidateQueries({ queryKey: ['keys'] });
    },
    onError: (e) => setErr(errorMessage(e)),
  });
  const canMake = (k: Key['kind']): boolean => (k === 'secret' ? isAdmin(role) : canWrite(role));

  return (
    <>
      <PageHeader title="API keys">
        {canWrite(role) && (
          <Button
            onClick={() => {
              setErr(undefined);
              setKind(isAdmin(role) ? 'secret' : 'publishable');
              setCreating(true);
            }}
          >
            Create key
          </Button>
        )}
      </PageHeader>
      <p className="mb-4 text-muted">
        Secret keys (<code>sk_</code>) act on your data from your backend and mint client tokens.
        Publishable keys (<code>pk_</code>) identify your tenant in client code and cannot read
        data.
      </p>
      {q.isLoading ? (
        <Skeleton />
      ) : q.error ? (
        <ErrorBanner error={q.error} retry={() => void q.refetch()} />
      ) : !q.data?.items.length ? (
        <EmptyState title="No keys yet." />
      ) : (
        <Card>
          <table className="responsive w-full text-left">
            <thead>
              <tr className="text-muted">
                <th scope="col" className="p-2">
                  Name
                </th>
                <th scope="col" className="p-2">
                  Key
                </th>
                <th scope="col" className="p-2">
                  Last used
                </th>
                <th scope="col" className="p-2">
                  Status
                </th>
                <th scope="col" className="p-2">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((k) => (
                <tr key={k.id} className="border-t border-line">
                  <td data-label="Name" className="p-2">
                    {k.name}
                  </td>
                  <td data-label="Key" className="p-2 font-mono">
                    {k.prefix}...
                  </td>
                  <td data-label="Last used" className="p-2">
                    {k.lastUsedAt ? fmtTime(k.lastUsedAt) : 'never'}
                  </td>
                  <td data-label="Status" className="p-2">
                    {k.revokedAt ? 'Revoked' : 'Active'} ({k.kind})
                  </td>
                  <td className="p-2 text-right">
                    {!k.revokedAt && canMake(k.kind) && (
                      <Button
                        variant="secondary"
                        aria-label={`Revoke ${k.name}`}
                        onClick={() => setRevoke(k)}
                      >
                        Revoke
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {creating && (
        <Modal title="Create API key" onClose={() => setCreating(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setErr(undefined);
              create.mutate();
            }}
          >
            <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
            <fieldset className="mb-4">
              <legend className="mb-1 font-medium">Kind</legend>
              <label className="mr-4">
                <input
                  type="radio"
                  name="kind"
                  checked={kind === 'publishable'}
                  onChange={() => setKind('publishable')}
                />{' '}
                Publishable
              </label>
              <label>
                <input
                  type="radio"
                  name="kind"
                  disabled={!isAdmin(role)}
                  checked={kind === 'secret'}
                  onChange={() => setKind('secret')}
                />{' '}
                Secret
              </label>
              {!isAdmin(role) && (
                <p className="mt-1 text-muted">Only owners and admins can create secret keys.</p>
              )}
            </fieldset>
            {err && <ErrorBanner error={err} />}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={create.isPending} disabled={name.trim() === ''}>
                Create
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {secret && (
        <SecretModal title="Copy your new key" secret={secret} onClose={() => setSecret(null)} />
      )}
      {revoke && (
        <Confirm
          title={`Revoke "${revoke.name}"?`}
          message="Anything using this key stops working within a minute. This cannot be undone."
          confirmLabel="Revoke"
          onConfirm={async () => {
            await api('DELETE', `/keys/${revoke.id}`);
            toast('ok', 'Key revoked');
            await qc.invalidateQueries({ queryKey: ['keys'] });
          }}
          onClose={() => setRevoke(null)}
        />
      )}
    </>
  );
}
