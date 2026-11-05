import { useEffect, useState } from 'react';

interface View {
  seq: number;
  text: string;
}

/** Flattens the server's XML fragment to plain text so it can be compared with the editor by eye. */
const plain = (content: unknown): string =>
  typeof content === 'string'
    ? content
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    : '';

/** "Server view": what the server itself holds for this note, refreshed every 2 s (DEM-01). */
export function ServerView({ id }: { id: string }) {
  const [view, setView] = useState<View | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const res = await fetch(`/demo/notes/${id}`);
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { seq: number; json: { content?: unknown } };
        if (alive) {
          setView({ seq: body.seq, text: plain(body.json.content) });
          setFailed(false);
        }
      } catch {
        if (alive) setFailed(true); // offline or server unreachable: keep the last view
      }
    };
    void load();
    const t = setInterval(() => void load(), 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id]);
  return (
    <section aria-label="Server view" className="mt-6">
      <h2 className="mb-1 font-semibold">Server view</h2>
      <p className="mb-2 text-muted">
        What the server holds right now. It lags your screen while you are offline.
      </p>
      <p data-testid="server-seq" className="text-muted">
        {failed ? 'Server unreachable' : view ? `Server seq ${String(view.seq)}` : 'Loading...'}
      </p>
      <p data-testid="server-text" className="break-words">
        {view?.text ?? ''}
      </p>
    </section>
  );
}
