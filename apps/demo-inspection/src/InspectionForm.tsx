import { useEffect, useState } from 'react';
import * as Y from 'yjs';
import { useDoc, useYMap } from '@syncra/react';
import type { SyncraDoc } from '@syncra/client';
import type { Session } from './syncra.js';

type State = 'pass' | 'fail' | 'na';
interface Item {
  label: string;
  state: State;
  comment: string;
}
interface Data {
  siteId?: string;
  inspector?: string;
  status?: 'draft' | 'submitted';
  checklist?: Item[];
  location?: { lat: number; lng: number; accuracy: number; at: number };
}

/** Replaces only the changed middle of a Y.Text so concurrent edits elsewhere in it survive. */
function setText(t: Y.Text, next: string): void {
  const prev = t.toJSON();
  let a = 0;
  while (a < prev.length && a < next.length && prev[a] === next[a]) a++;
  let b = 0;
  while (b < prev.length - a && b < next.length - a && prev.at(-1 - b) === next.at(-1 - b)) b++;
  t.doc?.transact(() => {
    t.delete(a, prev.length - a - b);
    t.insert(a, next.slice(a, next.length - b));
  });
}

function TextField({
  doc,
  field,
  label,
  disabled,
}: {
  doc: SyncraDoc;
  field: string;
  label: string;
  disabled: boolean;
}) {
  const [value, setValue] = useState('');
  // Observe the whole map: the text may not exist yet when the document is still loading or syncing.
  useEffect(() => {
    const root = doc.map();
    const read = (): void => {
      setValue((root.get(field) as Y.Text | undefined)?.toJSON() ?? '');
    };
    read();
    root.observeDeep(read);
    return () => {
      root.unobserveDeep(read);
    };
  }, [doc, field]);
  return (
    <>
      <label htmlFor={field}>{label}</label>
      <textarea
        id={field}
        rows={4}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const t = doc.map().get(field) as Y.Text | undefined;
          if (t) setText(t, e.target.value);
        }}
      />
    </>
  );
}

export function InspectionForm({
  id,
  session,
  go,
}: {
  id: string;
  session: Session;
  go: (r: string) => void;
}) {
  const { doc, state } = useDoc('inspections', id);
  const data = useYMap<Data>(doc);
  const [gpsError, setGpsError] = useState('');
  const isInspector = session.role === 'inspector';
  const locked = data.status === 'submitted' || !isInspector;

  if (!doc) return <p>Loading...</p>;
  const checklist = doc.map().get('checklist') as Y.Array<Y.Map<unknown>> | undefined;

  const stamp = (): void => {
    setGpsError('');
    navigator.geolocation.getCurrentPosition(
      (p) => {
        doc.map().set('location', {
          lat: p.coords.latitude,
          lng: p.coords.longitude,
          accuracy: p.coords.accuracy,
          at: Date.now(),
        });
      },
      (e) => {
        setGpsError(e.message);
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };

  return (
    <section>
      <p>
        <a href={`#/site/${data.siteId ?? ''}`}>&larr; Site</a>
      </p>
      <h1>
        Inspection{' '}
        <span className="badge" data-testid="insp-status">
          {data.status ?? 'draft'}
        </span>
      </h1>
      <p className="muted" data-testid="doc-state">
        {state === 'synced' ? 'Synced' : 'Saved on device'} - inspector {data.inspector ?? '...'}
      </p>

      <h2>Checklist</h2>
      <ul className="plain">
        {(data.checklist ?? []).map((item, i) => (
          <li key={i} className="check">
            <span>{item.label}</span>
            <span role="group" aria-label={`${item.label} result`}>
              {(['pass', 'fail', 'na'] as const).map((s) => (
                <button
                  key={s}
                  aria-pressed={item.state === s}
                  disabled={locked}
                  onClick={() => {
                    checklist?.get(i).set('state', s);
                  }}
                >
                  {s === 'na' ? 'N/A' : s}
                </button>
              ))}
            </span>
            <input
              aria-label={`${item.label} comment`}
              value={item.comment}
              disabled={locked}
              onChange={(e) => {
                checklist?.get(i).set('comment', e.target.value);
              }}
            />
          </li>
        ))}
      </ul>

      <TextField doc={doc} field="notes" label="Inspector notes" disabled={locked} />
      <TextField
        doc={doc}
        field="supervisorNote"
        label="Supervisor comment"
        disabled={isInspector}
      />

      <h2>Location</h2>
      {data.location ? (
        <p data-testid="gps">
          {data.location.lat.toFixed(5)}, {data.location.lng.toFixed(5)} (±
          {Math.round(data.location.accuracy)} m)
        </p>
      ) : (
        <p className="muted">No GPS stamp yet.</p>
      )}
      {gpsError && <p role="alert">{gpsError}</p>}
      <button onClick={stamp} disabled={locked}>
        Stamp my location
      </button>

      {isInspector && (
        <p>
          <button
            className="primary"
            disabled={data.status === 'submitted'}
            onClick={() => {
              doc.map().set('status', 'submitted');
              go(`/site/${data.siteId ?? ''}`);
            }}
          >
            Submit inspection
          </button>
        </p>
      )}
      <p className="muted help">
        Two people editing the same field at once: the last write wins for single values such as
        status or a checklist result. Notes and comments merge character by character, so nothing
        typed is lost.
      </p>
    </section>
  );
}
