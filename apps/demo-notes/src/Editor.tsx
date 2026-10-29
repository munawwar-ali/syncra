import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import type { SyncraDoc } from '@syncra/client';
import { useCollection, useDoc, usePresence, useSyncraClient } from '@syncra/react';
import type { DemoUser } from './syncra.js';

export function Editor({ id, user }: { id: string; user: DemoUser }) {
  const { doc } = useDoc('notes', id);
  return doc ? <EditorBody doc={doc} id={id} user={user} /> : null;
}

function EditorBody({ doc, id, user }: { doc: SyncraDoc; id: string; user: DemoUser }) {
  const client = useSyncraClient();
  const entries = useCollection('notes');
  const entry = entries.find((e) => e.id === id);
  const others = usePresence(doc);

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({ history: false }), // Yjs provides undo/redo semantics for collaboration
        Collaboration.configure({ document: doc.ydoc, field: 'content' }),
        CollaborationCursor.configure({ provider: { awareness: doc.awareness }, user }),
      ],
      editorProps: { attributes: { 'aria-label': 'Note body', 'data-testid': 'editor' } },
    },
    [doc],
  );

  const btn = (label: string, active: boolean, run: () => void) => (
    <button
      type="button"
      aria-pressed={active}
      onClick={run}
      className={`rounded-input px-2 py-1 ${active ? 'bg-surface-2 font-semibold' : 'hover:bg-surface'}`}
    >
      {label}
    </button>
  );

  return (
    <article>
      <div className="flex items-center justify-between gap-4 border-b border-line px-4 py-2">
        <input
          aria-label="Note title"
          className="min-w-0 flex-1 bg-transparent text-lg font-semibold outline-none"
          placeholder="Untitled note"
          value={entry?.title ?? ''}
          onChange={(e) => client.collection('notes').setTitle(id, e.target.value)}
        />
        <ul className="flex -space-x-2" aria-label="Collaborators" data-testid="collaborators">
          {others.map((o) => {
            const u = o.state.user as DemoUser | undefined;
            return (
              <li
                key={o.id}
                title={u?.name}
                className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-bg text-xs font-semibold text-white"
                style={{ background: u?.color ?? 'var(--offline)' }}
              >
                {(u?.name ?? '?').slice(0, 1).toUpperCase()}
              </li>
            );
          })}
        </ul>
      </div>
      {editor && (
        <div
          role="toolbar"
          aria-label="Formatting"
          className="flex gap-1 border-b border-line px-3 py-1"
        >
          {btn('Bold', editor.isActive('bold'), () => editor.chain().focus().toggleBold().run())}
          {btn('Italic', editor.isActive('italic'), () =>
            editor.chain().focus().toggleItalic().run(),
          )}
          {btn('H1', editor.isActive('heading', { level: 1 }), () =>
            editor.chain().focus().toggleHeading({ level: 1 }).run(),
          )}
          {btn('H2', editor.isActive('heading', { level: 2 }), () =>
            editor.chain().focus().toggleHeading({ level: 2 }).run(),
          )}
          {btn('List', editor.isActive('bulletList'), () =>
            editor.chain().focus().toggleBulletList().run(),
          )}
          {btn('Code', editor.isActive('code'), () => editor.chain().focus().toggleCode().run())}
        </div>
      )}
      <EditorContent editor={editor} />
    </article>
  );
}
