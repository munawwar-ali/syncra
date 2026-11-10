import { useCollection, useSyncraClient } from '@syncra/react';

export function NotesList(props: {
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const client = useSyncraClient();
  const entries = useCollection('notes');
  const notes = client.collection('notes');
  return (
    <nav aria-label="Notes">
      <button
        className="btn-lift mb-3 w-full rounded-input border border-primary bg-primary px-3 py-2 font-semibold text-primary-contrast"
        onClick={() => {
          const doc = notes.create();
          props.onSelect(doc.id);
        }}
      >
        New note
      </button>
      {entries.length === 0 && <p className="text-muted">No notes yet. Create one to start.</p>}
      <ul>
        {entries.map((e) => (
          <li key={e.id} className="mb-1 flex items-center gap-1">
            <button
              onClick={() => {
                props.onSelect(e.id);
              }}
              aria-current={props.selected === e.id}
              className={`min-w-0 flex-1 truncate rounded-input px-2 py-1.5 text-left ${
                props.selected === e.id ? 'bg-lime font-semibold text-ink' : 'hover:bg-surface-2'
              }`}
            >
              {e.title ?? 'Untitled note'}
            </button>
            <button
              aria-label={`Delete ${e.title ?? 'note'}`}
              className="rounded-input px-2 py-1 text-muted hover:text-danger"
              onClick={() => {
                notes.remove(e.id);
                if (props.selected === e.id) props.onSelect(null);
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
