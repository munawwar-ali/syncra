import { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCollection } from '@syncra/react';

/** 5,000 rows, ~20 in the DOM at a time (DEM-02 virtualization). Works offline from the local index. */
export function SitesList({ go }: { go: (r: string) => void }) {
  const sites = useCollection('sites');
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? sites.filter((s) => (s.title ?? s.id).toLowerCase().includes(needle)) : sites;
  }, [sites, q]);
  const parent = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({
    count: shown.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 52,
    overscan: 8,
  });
  return (
    <section aria-label="Sites">
      <h1>Sites</h1>
      <label htmlFor="search" className="sr">
        Search sites
      </label>
      <input
        id="search"
        type="search"
        placeholder="Search sites"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
        }}
      />
      <p className="muted" data-testid="site-count">
        {shown.length} of {sites.length} sites
      </p>
      <div ref={parent} className="vlist" data-testid="site-list">
        <div style={{ height: v.getTotalSize(), position: 'relative' }}>
          {v.getVirtualItems().map((row) => {
            const s = shown[row.index];
            if (!s) return null;
            return (
              <button
                key={s.id}
                className="vrow"
                style={{ transform: `translateY(${String(row.start)}px)`, height: row.size }}
                onClick={() => {
                  go(`/site/${s.id}`);
                }}
              >
                {s.title ?? s.id}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
