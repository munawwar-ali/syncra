import { useState } from 'react';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { api } from '../api';
import { isAdmin, useAuth } from '../auth';
import { useTitle } from '../hooks';
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  PageHeader,
  Skeleton,
  errorMessage,
  fmtTime,
} from '../ui';

interface Row {
  id: number;
  actorType: string;
  actorId: string;
  action: string;
  target: string | null;
  createdAt: string;
}

export function Audit() {
  useTitle('Audit log');
  const auth = useAuth();
  const [result, setResult] = useState<{ valid: boolean; brokenAtId: number | null } | null>(null);
  const q = useInfiniteQuery({
    queryKey: ['audit', auth.active?.tenantId],
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      api<{ items: Row[]; nextCursor: string | null }>(
        'GET',
        `/audit?limit=25${pageParam ? `&cursor=${pageParam}` : ''}`,
      ),
    getNextPageParam: (l) => l.nextCursor ?? undefined,
    enabled: isAdmin(auth.active?.role),
  });
  const verify = useMutation({
    mutationFn: () =>
      api<{ valid: boolean; brokenAtId: number | null }>('GET', '/audit?verify=true'),
    onSuccess: setResult,
  });
  if (!isAdmin(auth.active?.role))
    return (
      <>
        <PageHeader title="Audit log" />
        <p className="text-muted">The audit log is visible to owners and admins.</p>
      </>
    );
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <PageHeader title="Audit log">
        <div className="flex items-center gap-3">
          {result && (
            <span
              role="status"
              data-testid="verify-result"
              className={result.valid ? 'text-success-text' : 'text-danger'}
            >
              {result.valid
                ? 'Chain verified: no tampering detected'
                : `Tampered: chain breaks at entry ${String(result.brokenAtId)}`}
            </span>
          )}
          <Button variant="secondary" loading={verify.isPending} onClick={() => verify.mutate()}>
            Verify chain
          </Button>
        </div>
      </PageHeader>
      {verify.error && <ErrorBanner error={errorMessage(verify.error)} />}
      {q.isLoading ? (
        <Skeleton rows={5} />
      ) : q.error ? (
        <ErrorBanner error={q.error} retry={() => void q.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title="No audit entries yet." />
      ) : (
        <Card>
          <table className="responsive w-full text-left">
            <thead>
              <tr className="text-muted">
                <th scope="col" className="p-2">
                  When
                </th>
                <th scope="col" className="p-2">
                  Action
                </th>
                <th scope="col" className="p-2">
                  Actor
                </th>
                <th scope="col" className="p-2">
                  Target
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-line">
                  <td data-label="When" className="p-2">
                    {fmtTime(r.createdAt)}
                  </td>
                  <td data-label="Action" className="p-2 font-mono">
                    {r.action}
                  </td>
                  <td data-label="Actor" className="p-2">
                    {r.actorType}
                  </td>
                  <td data-label="Target" className="break-all p-2 font-mono">
                    {r.target ?? '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {q.hasNextPage && (
            <div className="mt-3 text-center">
              <Button
                variant="secondary"
                loading={q.isFetchingNextPage}
                onClick={() => void q.fetchNextPage()}
              >
                Load more
              </Button>
            </div>
          )}
        </Card>
      )}
    </>
  );
}
