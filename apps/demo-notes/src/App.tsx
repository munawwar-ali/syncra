import { useEffect, useState } from 'react';
import type { SyncraClient } from '@syncra/client';
import { SyncraProvider } from '@syncra/react';
import { ChaosPanel } from './ChaosPanel.js';
import { ServerView } from './ServerView.js';
import { Editor } from './Editor.js';
import { NotesList } from './NotesList.js';
import { SyncBadge } from './SyncBadge.js';
import { OFFLINE_KEY, makeClient, type DemoUser } from './syncra.js';

const COLORS = ['#7c3aed', '#db2777', '#ea580c', '#0891b2', '#16a34a', '#2563eb'];
const USER_KEY = 'syncra-demo-user';

function loadUser(): DemoUser | null {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) ?? 'null') as DemoUser | null;
  } catch {
    return null;
  }
}

export function App() {
  const [user, setUser] = useState<DemoUser | null>(loadUser);
  return user ? (
    <Workspace
      user={user}
      onLogout={() => {
        setUser(null);
      }}
    />
  ) : (
    <Login onLogin={setUser} />
  );
}

function Login({ onLogin }: { onLogin: (u: DemoUser) => void }) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(COLORS[0] as string);
  return (
    <main className="page-in mx-auto mt-20 max-w-sm px-4">
      <div className="mb-6 flex items-center gap-2 rounded-card bg-ink px-4 py-3 text-lg font-bold tracking-tight text-ivory">
        <svg width="28" height="28" viewBox="0 0 64 64" aria-hidden="true">
          <defs>
            <clipPath id="syncra-logo-clip-login">
              <circle cx="24" cy="32" r="18" />
            </clipPath>
          </defs>
          <circle cx="24" cy="32" r="18" fill="#faf8f3" />
          <circle cx="40" cy="32" r="18" fill="#cdf22b" />
          <circle cx="40" cy="32" r="18" fill="#08090b" clipPath="url(#syncra-logo-clip-login)" />
        </svg>
        syncra <span className="font-normal text-ivory/60">notes</span>
      </div>
      <div className="rounded-card border border-line bg-surface p-6 shadow-[6px_6px_0_var(--lime)]">
        <h1 className="mb-1 text-2xl font-extrabold tracking-tight">Syncra Notes</h1>
        <p className="mb-6 text-muted">
          Pick a name and a color. No password needed for this demo.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const u = { name: name.trim(), color };
            if (!u.name) return;
            localStorage.setItem(USER_KEY, JSON.stringify(u));
            onLogin(u);
          }}
        >
          <label className="mb-1 block font-medium" htmlFor="name">
            Your name
          </label>
          <input
            id="name"
            className="mb-4 w-full rounded-input border border-line bg-bg px-3 py-2"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
            autoFocus
          />
          <fieldset className="mb-6">
            <legend className="mb-1 font-medium">Color</legend>
            <div className="flex gap-2">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Color ${c}`}
                  aria-pressed={color === c}
                  onClick={() => {
                    setColor(c);
                  }}
                  className="h-8 w-8 rounded-full border-2"
                  style={{
                    background: c,
                    borderColor: color === c ? 'var(--text)' : 'transparent',
                  }}
                />
              ))}
            </div>
          </fieldset>
          <button className="btn-lift w-full rounded-input border border-primary bg-primary px-3 py-2 font-semibold text-primary-contrast">
            Start
          </button>
        </form>
      </div>
    </main>
  );
}

function useHashNote(): [string | null, (id: string | null) => void] {
  const read = (): string | null => /^#\/note\/(.+)$/.exec(location.hash)?.[1] ?? null;
  const [id, setId] = useState(read);
  useEffect(() => {
    const h = (): void => {
      setId(read());
    };
    window.addEventListener('hashchange', h);
    return () => {
      window.removeEventListener('hashchange', h);
    };
  }, []);
  return [id, (next) => (location.hash = next ? `#/note/${next}` : '')];
}

function Workspace({ user, onLogout }: { user: DemoUser; onLogout: () => void }) {
  // Created in an effect (not during render) so React StrictMode's mount/unmount/mount cycle
  // never reuses a destroyed client.
  const [client, setClient] = useState<SyncraClient | null>(null);
  useEffect(() => {
    const c = makeClient(user);
    // A reload while "offline" (chaos panel) must stay offline, like a phone in a basement.
    if (sessionStorage.getItem(OFFLINE_KEY) === '1') c.simulateOffline(true);
    // Test hook: e2e specs read leader/connection state from the page.
    if (import.meta.env.DEV) (window as unknown as { __syncra: SyncraClient }).__syncra = c;
    setClient(c);
    return () => {
      setClient(null);
      void c.destroy();
    };
  }, [user]);
  const [noteId, setNoteId] = useHashNote();

  if (!client) return null;
  return (
    <SyncraProvider client={client}>
      <div className="flex h-screen flex-col">
        <header className="flex items-center justify-between border-b border-line bg-ink px-4 py-2 text-ivory">
          <div className="flex items-center gap-2 font-bold tracking-tight">
            <svg width="26" height="26" viewBox="0 0 64 64" aria-hidden="true">
              <defs>
                <clipPath id="syncra-logo-clip">
                  <circle cx="24" cy="32" r="18" />
                </clipPath>
              </defs>
              <circle cx="24" cy="32" r="18" fill="#faf8f3" />
              <circle cx="40" cy="32" r="18" fill="#cdf22b" />
              <circle cx="40" cy="32" r="18" fill="#08090b" clipPath="url(#syncra-logo-clip)" />
            </svg>
            syncra <span className="font-normal text-ivory/60">notes</span>
          </div>
          <div className="flex items-center gap-4">
            <SyncBadge />
            <span className="text-ivory/70">
              {user.name}{' '}
              <button
                className="underline"
                onClick={() => {
                  void client.clearLocalData().then(() => {
                    localStorage.removeItem(USER_KEY);
                    onLogout();
                  });
                }}
              >
                Log out
              </button>
            </span>
          </div>
        </header>
        <div className="flex min-h-0 flex-1">
          <aside className="w-64 shrink-0 overflow-y-auto border-r border-line bg-surface p-3">
            <NotesList selected={noteId} onSelect={setNoteId} />
          </aside>
          <main className="min-w-0 flex-1 overflow-y-auto">
            {noteId ? (
              <Editor key={noteId} id={noteId} user={user} />
            ) : (
              <div className="page-in grid h-full place-items-center p-6 text-center">
                <div>
                  <p className="text-xl font-extrabold tracking-tight">Pick or create a note</p>
                  <p className="mt-1 text-muted">
                    Open this page in a second window, then try going offline.
                  </p>
                </div>
              </div>
            )}
          </main>
          <aside className="w-60 shrink-0 overflow-y-auto border-l border-line bg-surface p-3">
            <ChaosPanel />
            {noteId && <ServerView key={noteId} id={noteId} />}
          </aside>
        </div>
      </div>
    </SyncraProvider>
  );
}
