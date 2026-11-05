import { useState } from 'react';
import * as Y from 'yjs';
import { useCollection, useSyncraClient } from '@syncra/react';
import { TEMPLATE_IDS, type Session } from './syncra.js';

/** Inspection index titles look like `site-0007|Site safety walk|2026-01-01`, so history needs no extra reads. */
export const inspectionTitle = (siteId: string, template: string, at: number): string =>
  `${siteId}|${template}|${new Date(at).toISOString().slice(0, 16).replace('T', ' ')}`;

export function SiteDetail({
  siteId,
  session,
  go,
}: {
  siteId: string;
  session: Session;
  go: (r: string) => void;
}) {
  const client = useSyncraClient();
  const sites = useCollection('sites');
  const history = useCollection('inspections').filter((e) => e.title?.startsWith(`${siteId}|`));
  const site = sites.find((s) => s.id === siteId);
  const [tpl, setTpl] = useState<string>(TEMPLATE_IDS[0]);

  const start = (): void => {
    const template = client.doc('templates', tpl);
    void template.whenLoaded().then(() => {
      const t = template.map().toJSON() as { name?: string; items?: string[] };
      const id = crypto.randomUUID();
      const at = Date.now();
      const doc = client.collection('inspections').create(id);
      doc.ydoc.transact(() => {
        const m = doc.map();
        m.set('siteId', siteId);
        m.set('inspector', session.name);
        m.set('startedAt', at);
        m.set('status', 'draft');
        m.set('notes', new Y.Text());
        m.set('supervisorNote', new Y.Text());
        m.set(
          'checklist',
          Y.Array.from(
            (t.items ?? []).map((label) => {
              const item = new Y.Map<unknown>();
              item.set('label', label);
              item.set('state', 'na');
              item.set('comment', '');
              return item;
            }),
          ),
        );
      });
      client.collection('inspections').setTitle(id, inspectionTitle(siteId, t.name ?? tpl, at));
      template.close();
      go(`/inspection/${id}`);
    });
  };

  return (
    <section>
      <p>
        <a href="#/">&larr; All sites</a>
      </p>
      <h1>{site?.title ?? siteId}</h1>
      {session.role === 'inspector' && (
        <div className="row">
          <label htmlFor="tpl">Checklist template</label>
          <TemplateSelect value={tpl} onChange={setTpl} />
          <button className="primary" onClick={start}>
            New inspection
          </button>
        </div>
      )}
      <h2>Inspection history</h2>
      {history.length === 0 && <p className="muted">No inspections yet.</p>}
      <ul className="plain">
        {history.map((h) => (
          <li key={h.id}>
            <a href={`#/inspection/${h.id}`}>{(h.title ?? '').split('|').slice(1).join(' - ')}</a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function TemplateSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select
      id="tpl"
      value={value}
      onChange={(e) => {
        onChange(e.target.value);
      }}
    >
      {TEMPLATE_IDS.map((id) => (
        <option key={id} value={id}>
          {id}
        </option>
      ))}
    </select>
  );
}
