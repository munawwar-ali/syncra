import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { isAdmin, useAuth } from '../auth';
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
  Skeleton,
  errorMessage,
  fmtTime,
  useToast,
} from '../ui';

type Role = 'owner' | 'admin' | 'developer' | 'viewer';
interface Member {
  userId: string;
  email: string;
  name: string;
  role: Role;
  joinedAt: string;
}
interface Invitation {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
}

export function Members() {
  useTitle('Members');
  const auth = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const manage = isAdmin(auth.active?.role);
  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'developer' | 'viewer'>('developer');
  const [link, setLink] = useState<string | null>(null);
  const [err, setErr] = useState<string>();
  const [remove, setRemove] = useState<Member | null>(null);
  const q = useQuery({
    queryKey: ['members', auth.active?.tenantId],
    queryFn: () => api<{ members: Member[]; invitations: Invitation[] }>('GET', '/tenant/members'),
  });
  const invite = useMutation({
    mutationFn: () => api<{ url: string }>('POST', '/tenant/invitations', { email, role }),
    onSuccess: (r) => {
      setInviting(false);
      setEmail('');
      setLink(r.url);
      void qc.invalidateQueries({ queryKey: ['members'] });
    },
    onError: (e) => setErr(errorMessage(e)),
  });
  const changeRole = useMutation({
    mutationFn: (v: { userId: string; role: string }) =>
      api('PATCH', `/tenant/members/${v.userId}`, { role: v.role }),
    onSuccess: () => {
      toast('ok', 'Role updated');
      void qc.invalidateQueries({ queryKey: ['members'] });
    },
    onError: (e) => toast('error', errorMessage(e)),
  });

  return (
    <>
      <PageHeader title="Members">
        {manage && (
          <Button
            onClick={() => {
              setErr(undefined);
              setInviting(true);
            }}
          >
            Invite member
          </Button>
        )}
      </PageHeader>
      {q.isLoading ? (
        <Skeleton />
      ) : q.error ? (
        <ErrorBanner error={q.error} retry={() => void q.refetch()} />
      ) : (
        q.data && (
          <>
            <Card title="People">
              <table className="responsive w-full text-left">
                <thead>
                  <tr className="text-muted">
                    <th scope="col" className="p-2">
                      Name
                    </th>
                    <th scope="col" className="p-2">
                      Email
                    </th>
                    <th scope="col" className="p-2">
                      Role
                    </th>
                    <th scope="col" className="p-2">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.members.map((m) => (
                    <tr key={m.userId} className="border-t border-line">
                      <td data-label="Name" className="p-2">
                        {m.name}
                      </td>
                      <td data-label="Email" className="p-2">
                        {m.email}
                      </td>
                      <td data-label="Role" className="p-2">
                        {manage &&
                        m.role !== 'owner' &&
                        (m.role !== 'admin' || auth.active?.role === 'owner') ? (
                          <>
                            <label className="sr-only" htmlFor={`role-${m.userId}`}>
                              Role for {m.name}
                            </label>
                            <select
                              id={`role-${m.userId}`}
                              className="rounded-input border border-line bg-bg px-2 py-1"
                              value={m.role}
                              onChange={(e) =>
                                changeRole.mutate({ userId: m.userId, role: e.target.value })
                              }
                            >
                              <option value="admin">admin</option>
                              <option value="developer">developer</option>
                              <option value="viewer">viewer</option>
                            </select>
                          </>
                        ) : (
                          m.role
                        )}
                      </td>
                      <td className="p-2 text-right">
                        {manage &&
                          m.role !== 'owner' &&
                          (m.role !== 'admin' || auth.active?.role === 'owner') && (
                            <Button
                              variant="secondary"
                              aria-label={`Remove ${m.name}`}
                              onClick={() => setRemove(m)}
                            >
                              Remove
                            </Button>
                          )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <Card title="Pending invitations">
              {q.data.invitations.length === 0 ? (
                <EmptyState title="No pending invitations." />
              ) : (
                <ul>
                  {q.data.invitations.map((i) => (
                    <li
                      key={i.id}
                      className="flex justify-between border-b border-line py-2 last:border-0"
                    >
                      <span>
                        {i.email} ({i.role})
                      </span>
                      <span className="text-muted">expires {fmtTime(i.expiresAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </>
        )
      )}
      {inviting && (
        <Modal title="Invite a member" onClose={() => setInviting(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setErr(undefined);
              invite.mutate();
            }}
          >
            <Field
              label="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <div className="mb-4">
              <label htmlFor="invite-role" className="mb-1 block font-medium">
                Role
              </label>
              <select
                id="invite-role"
                className="w-full rounded-input border border-line bg-bg px-3 py-2"
                value={role}
                onChange={(e) => setRole(e.target.value as typeof role)}
              >
                <option value="admin">admin</option>
                <option value="developer">developer</option>
                <option value="viewer">viewer</option>
              </select>
            </div>
            {err && <ErrorBanner error={err} />}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setInviting(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={invite.isPending}>
                Send invite
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {link && (
        <Modal title="Invitation link" onClose={() => setLink(null)}>
          <p className="mb-2 text-muted">
            Email delivery is not configured, so share this link yourself. It expires in 7 days.
          </p>
          <code className="mb-4 block break-all rounded-input bg-surface-2 p-3 font-mono">
            {link}
          </code>
          <div className="flex justify-end">
            <Button onClick={() => setLink(null)}>Done</Button>
          </div>
        </Modal>
      )}
      {remove && (
        <Confirm
          title={`Remove ${remove.name}?`}
          message="They lose access to this organization immediately."
          confirmLabel="Remove"
          onConfirm={async () => {
            await api('DELETE', `/tenant/members/${remove.userId}`);
            toast('ok', 'Member removed');
            await qc.invalidateQueries({ queryKey: ['members'] });
          }}
          onClose={() => setRemove(null)}
        />
      )}
    </>
  );
}
