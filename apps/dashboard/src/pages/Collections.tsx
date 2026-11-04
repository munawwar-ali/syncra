import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { canWrite, useAuth } from '../auth';
import { useTitle } from '../hooks';
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Field,
  Modal,
  PageHeader,
  Skeleton,
  fmtBytes,
  fmtNum,
  fmtTime,
  useToast,
  errorMessage,
} from '../ui';

interface Collection {
  name: string;
  documents: number;
  sizeBytes: number;
}
interface DocMeta {
  id: string;
  seq: number;
  sizeBytes: number;
  updatedAt: string;
}

export function Collections() {
  useTitle('Collections');
  const auth = useAuth();
  const q = useQuery({
    queryKey: ['collections', auth.active?.tenantId],
    queryFn: () => api<{ items: Collection[] }>('GET', '/collections'),
  });
  return (
    <>
      <PageHeader title="Collections" />
      {q.isLoading ? (
        <Skeleton />
      ) : q.error ? (
        <ErrorBanner error={q.error} retry={() => void q.refetch()} />
      ) : q.data?.items.length === 0 ? (
        <EmptyState
          title="No collections yet. Create a document in any collection from your app, or add one here."
          action={<NewDoc collection="" />}
        />
      ) : (
        <Card>
          <table className="responsive w-full text-left">
            <thead>
              <tr className="text-muted">
                <th scope="col" className="p-2">
                  Collection
                </th>
                <th scope="col" className="p-2">
                  Documents
                </th>
                <th scope="col" className="p-2">
                  Size
                </th>
              </tr>
            </thead>
            <tbody>
              {q.data?.items.map((c) => (
                <tr key={c.name} className="border-t border-line">
                  <td data-label="Collection" className="p-2">
                    <Link className="font-medium underline" to={`/collections/${c.name}`}>
                      {c.name}
                    </Link>
                  </td>
                  <td data-label="Documents" className="p-2">
                    {fmtNum(c.documents)}
                  </td>
                  <td data-label="Size" className="p-2">
                    {fmtBytes(c.sizeBytes)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}

function NewDoc({ collection }: { collection: string }) {
  const auth = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [c, setC] = useState(collection);
  const [id, setId] = useState('');
  const [json, setJson] = useState('{}');
  const [err, setErr] = useState<string>();
  const create = useMutation({
    mutationFn: async () => {
      let initial: unknown;
      try {
        initial = JSON.parse(json);
      } catch {
        throw new Error('Initial data must be valid JSON');
      }
      if (typeof initial !== 'object' || initial === null || Array.isArray(initial))
        throw new Error('Initial data must be a JSON object');
      return api<{ id: string }>('POST', `/collections/${c}/docs`, {
        ...(id ? { id } : {}),
        initial,
      });
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['collections'] });
      void qc.invalidateQueries({ queryKey: ['docs'] });
      toast('ok', 'Document created');
      setOpen(false);
      nav(`/collections/${c}/${r.id}`);
    },
    onError: (e) => setErr(errorMessage(e)),
  });
  if (!canWrite(auth.active?.role)) return null;
  return (
    <>
      <Button onClick={() => setOpen(true)}>New document</Button>
      {open && (
        <Modal title="New document" onClose={() => setOpen(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setErr(undefined);
              create.mutate();
            }}
          >
            <Field
              label="Collection"
              hint="Lowercase letters, digits, - and _"
              value={c}
              onChange={(e) => setC(e.target.value)}
              disabled={collection !== ''}
            />
            <Field
              label="Document id (optional)"
              value={id}
              onChange={(e) => setId(e.target.value)}
            />
            <div className="mb-4">
              <label htmlFor="initial" className="mb-1 block font-medium">
                Initial data (JSON)
              </label>
              <textarea
                id="initial"
                className="h-24 w-full rounded-input border border-line bg-bg p-2 font-mono"
                value={json}
                onChange={(e) => setJson(e.target.value)}
              />
            </div>
            {err && <ErrorBanner error={err} />}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={create.isPending}>
                Create
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

export function Documents() {
  const { c = '' } = useParams();
  useTitle(`${c} documents`);
  const auth = useAuth();
  const [prefix, setPrefix] = useState('');
  const [applied, setApplied] = useState('');
  const q = useInfiniteQuery({
    queryKey: ['docs', auth.active?.tenantId, c, applied],
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      api<{ items: DocMeta[]; nextCursor: string | null }>(
        'GET',
        `/collections/${c}/docs?limit=25${applied ? `&prefix=${encodeURIComponent(applied)}` : ''}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <PageHeader title={`Collection: ${c}`}>
        <NewDoc collection={c} />
      </PageHeader>
      <form
        className="mb-4 flex items-end gap-2"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(prefix);
        }}
      >
        <div className="grow">
          <Field
            label="Search by id prefix"
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
          />
        </div>
        <Button type="submit" variant="secondary" className="mb-4">
          Search
        </Button>
      </form>
      {q.isLoading ? (
        <Skeleton rows={5} />
      ) : q.error ? (
        <ErrorBanner error={q.error} retry={() => void q.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          title={
            applied
              ? `No documents start with "${applied}".`
              : 'No documents in this collection yet.'
          }
        />
      ) : (
        <Card>
          <table className="responsive w-full text-left">
            <thead>
              <tr className="text-muted">
                <th scope="col" className="p-2">
                  Id
                </th>
                <th scope="col" className="p-2">
                  Seq
                </th>
                <th scope="col" className="p-2">
                  Size
                </th>
                <th scope="col" className="p-2">
                  Updated
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((d) => (
                <tr key={d.id} className="border-t border-line">
                  <td data-label="Id" className="p-2 font-mono">
                    <Link
                      className="underline"
                      to={`/collections/${c}/${encodeURIComponent(d.id)}`}
                    >
                      {d.id}
                    </Link>
                  </td>
                  <td data-label="Seq" className="p-2">
                    {fmtNum(d.seq)}
                  </td>
                  <td data-label="Size" className="p-2">
                    {fmtBytes(d.sizeBytes)}
                  </td>
                  <td data-label="Updated" className="p-2">
                    {fmtTime(d.updatedAt)}
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
