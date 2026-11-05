import { useEffect, useState } from 'react';
import type { SyncraClient } from '@syncra/client';
import { SyncraProvider, useSyncStatus } from '@syncra/react';
import { InspectionForm } from './InspectionForm.js';
import { SiteDetail } from './SiteDetail.js';
import { SitesList } from './SitesList.js';
import { TEMPLATE_IDS, makeClient, type Role, type Session } from './syncra.js';

const SESSION_KEY = 'inspection-session';

function load(): Session | null {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as Session | null;
  } catch {
    return null;
  }
}

/** Hash routes keep the app a static shell the service worker can serve offline. */
function useRoute(): [string, (r: string) => void] {
  const [route, setRoute] = useState(() => location.hash.slice(1) || '/');
  useEffect(() => {
    const h = (): void => {
      setRoute(location.hash.slice(1) || '/');
    };
    window.addEventListener('hashchange', h);
    return () => {
      window.removeEventListener('hashchange', h);
    };
  }, []);
  return [
    route,
    (r) => {
      location.hash = r;
    },
  ];
}

export function App() {
  const [session, setSession] = useState<Session | null>(load);
  return session ? (
    <Workspace
      session={session}
      onLogout={() => {
        localStorage.removeItem(SESSION_KEY);
        setSession(null);
      }}
    />
  ) : (
    <Login
      onLogin={(s) => {
        localStorage.setItem(SESSION_KEY, JSON.stringify(s));
        setSession(s);
      }}
    />
  );
}

function Login({ onLogin }: { onLogin: (s: Session) => void }) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('inspector');
  return (
    <main className="login">
      <h1>Field Inspection</h1>
      <p className="muted">Pick a name and a role. No password for this demo.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onLogin({ name: name.trim(), role });
        }}
      >
        <label htmlFor="name">Your name</label>
        <input
          id="name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
          autoFocus
        />
        <fieldset>
          <legend>Role</legend>
          {(['inspector', 'supervisor'] as const).map((r) => (
            <label key={r} className="radio">
              <input
                type="radio"
                name="role"
                checked={role === r}
                onChange={() => {
                  setRole(r);
                }}
              />
              {r === 'inspector'
                ? 'Inspector (fills in inspections)'
                : 'Supervisor (reviews and comments)'}
            </label>
          ))}
        </fieldset>
        <button type="submit" className="primary">
          Start
        </button>
      </form>
    </main>
  );
}

function StatusBar({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const s = useSyncStatus();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
    }, 5000);
    return () => {
      clearInterval(t);
    };
  }, []);
  const synced = s.lastSyncedAt
    ? `${String(Math.max(0, Math.round((now - s.lastSyncedAt) / 60000)))} min ago`
    : 'never';
  return (
    <header className="statusbar" role="status" aria-live="polite">
      <a href="#/" className="brand">
        Inspections
      </a>
      <span data-testid="conn" data-state={s.connection}>
        {s.connection === 'live' ? 'Online' : s.online ? 'Connecting' : 'Offline'}
      </span>
      <span data-testid="pending">{s.pendingOps} unsynced</span>
      <span data-testid="saved">{s.pendingOps > 0 ? 'Saved on device' : 'All changes synced'}</span>
      <span className="muted">Last synced {synced}</span>
      <span className="grow" />
      <span className="muted">
        {session.name} ({session.role}){' '}
        <button className="link" onClick={onLogout}>
          Log out
        </button>
      </span>
    </header>
  );
}

function Workspace({ session, onLogout }: { session: Session; onLogout: () => void }) {
  // Created in an effect so React StrictMode never reuses a destroyed client.
  const [client, setClient] = useState<SyncraClient | null>(null);
  const [route, go] = useRoute();
  useEffect(() => {
    const c = makeClient(session);
    // Keep the three checklist templates open so inspections can be started with no network.
    const open = TEMPLATE_IDS.map((id) => c.doc('templates', id));
    if (import.meta.env.DEV || import.meta.env.MODE === 'e2e') {
      (window as unknown as { __syncra: SyncraClient }).__syncra = c;
    }
    setClient(c);
    return () => {
      open.forEach((d) => {
        d.close();
      });
      setClient(null);
      void c.destroy();
    };
  }, [session]);

  if (!client) return null;
  const parts = route.split('/');
  return (
    <SyncraProvider client={client}>
      <StatusBar
        session={session}
        onLogout={() => {
          void client.clearLocalData().then(onLogout);
        }}
      />
      <main className="page">
        {parts[1] === 'site' && parts[2] ? (
          <SiteDetail siteId={parts[2]} session={session} go={go} />
        ) : parts[1] === 'inspection' && parts[2] ? (
          <InspectionForm id={parts[2]} session={session} go={go} />
        ) : (
          <SitesList go={go} />
        )}
      </main>
    </SyncraProvider>
  );
}
