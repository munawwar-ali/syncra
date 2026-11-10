import { lazy, Suspense, useEffect, useState } from 'react';
import { Navigate, NavLink, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { isAdmin, useAuth } from './auth';
import { AcceptInvite, Login, Signup } from './pages/AuthPages';
import { Logo, Skeleton } from './ui';

const Overview = lazy(() => import('./pages/Overview').then((m) => ({ default: m.Overview })));
const Collections = lazy(() =>
  import('./pages/Collections').then((m) => ({ default: m.Collections })),
);
const Documents = lazy(() => import('./pages/Collections').then((m) => ({ default: m.Documents })));
const Inspector = lazy(() => import('./pages/Inspector').then((m) => ({ default: m.Inspector })));
const Keys = lazy(() => import('./pages/Keys').then((m) => ({ default: m.Keys })));
const Usage = lazy(() => import('./pages/Usage').then((m) => ({ default: m.Usage })));
const Webhooks = lazy(() => import('./pages/Webhooks').then((m) => ({ default: m.Webhooks })));
const Members = lazy(() => import('./pages/Members').then((m) => ({ default: m.Members })));
const Audit = lazy(() => import('./pages/Audit').then((m) => ({ default: m.Audit })));
const Monitor = lazy(() => import('./pages/Monitor').then((m) => ({ default: m.Monitor })));
const Playground = lazy(() =>
  import('./pages/Playground').then((m) => ({ default: m.Playground })),
);
const Settings = lazy(() => import('./pages/Settings').then((m) => ({ default: m.Settings })));

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/accept-invite" element={<AcceptInvite />} />
      <Route element={<Protected />}>
        <Route index element={<Overview />} />
        <Route path="collections" element={<Collections />} />
        <Route path="collections/:c" element={<Documents />} />
        <Route path="collections/:c/:id" element={<Inspector />} />
        <Route path="keys" element={<Keys />} />
        <Route path="usage" element={<Usage />} />
        <Route path="webhooks" element={<Webhooks />} />
        <Route path="members" element={<Members />} />
        <Route path="audit" element={<Audit />} />
        <Route path="monitor" element={<Monitor />} />
        <Route path="playground" element={<Playground />} />
        <Route path="settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

const THEME_KEY = 'syncra-dashboard-theme';

function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState<string>(() => {
    try {
      return localStorage.getItem(THEME_KEY) ?? 'system';
    } catch {
      return 'system';
    }
  });
  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // per-viewer convenience only
    }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))];
}

function Protected() {
  const auth = useAuth();
  const loc = useLocation();
  if (auth.status === 'loading') {
    return (
      <div className="mx-auto mt-24 max-w-sm p-4">
        <Skeleton />
      </div>
    );
  }
  if (auth.status === 'anonymous')
    return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  return <Shell />;
}

const NAV: { to: string; label: string; admin?: boolean }[] = [
  { to: '/', label: 'Overview' },
  { to: '/collections', label: 'Collections' },
  { to: '/keys', label: 'API keys' },
  { to: '/usage', label: 'Usage & billing' },
  { to: '/webhooks', label: 'Webhooks' },
  { to: '/members', label: 'Members' },
  { to: '/audit', label: 'Audit log', admin: true },
  { to: '/monitor', label: 'Live monitor' },
  { to: '/playground', label: 'Playground' },
  { to: '/settings', label: 'Settings' },
];

function Shell() {
  const auth = useAuth();
  const [theme, toggleTheme] = useTheme();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => {
    setOpen(false);
  }, [loc.pathname]);

  return (
    <div className="min-h-screen md:flex">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-bg focus:p-2"
      >
        Skip to content
      </a>
      <button
        className="m-2 rounded-input border border-line px-3 py-2 md:hidden"
        aria-expanded={open}
        aria-controls="sidebar"
        onClick={() => setOpen((o) => !o)}
      >
        Menu
      </button>
      <nav
        id="sidebar"
        aria-label="Main"
        className={`${open ? 'block' : 'hidden'} w-full shrink-0 border-r border-line bg-ink p-3 text-ivory md:block md:w-60`}
      >
        <div className="mb-5 flex items-center gap-2 px-2 text-lg font-bold tracking-tight">
          <Logo size={28} />
          syncra
        </div>
        <ul>
          {NAV.filter((n) => !n.admin || isAdmin(auth.active?.role)).map((n) => (
            <li key={n.to}>
              <NavLink
                to={n.to}
                end={n.to === '/'}
                className={({ isActive }) =>
                  `mb-1 block rounded-input px-3 py-2 transition-colors ${isActive ? 'bg-lime font-semibold text-ink' : 'text-ivory/80 hover:bg-white/10 hover:text-ivory'}`
                }
              >
                {n.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-w-0 flex-1">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface px-4 py-2">
          <div>
            {auth.memberships.length > 1 ? (
              <>
                <label htmlFor="tenant" className="sr-only">
                  Organization
                </label>
                <select
                  id="tenant"
                  className="rounded-input border border-line bg-bg px-2 py-1"
                  value={auth.active?.tenantId}
                  onChange={(e) => auth.switchTenant(e.target.value)}
                >
                  {auth.memberships.map((m) => (
                    <option key={m.tenantId} value={m.tenantId}>
                      {m.tenantName}
                    </option>
                  ))}
                </select>
              </>
            ) : (
              <span className="font-medium">{auth.active?.tenantName}</span>
            )}
            <span className="ml-2 text-muted">{auth.active?.role}</span>
          </div>
          <div className="flex items-center gap-3">
            <button
              className="rounded-input border border-line px-2 py-1"
              onClick={toggleTheme}
              aria-label={`${theme === 'dark' ? 'Light' : 'Dark'} theme`}
            >
              {theme === 'dark' ? 'Light' : 'Dark'}
            </button>
            <span className="text-muted">{auth.user?.email}</span>
            <button className="underline" onClick={() => void auth.logout()}>
              Log out
            </button>
          </div>
        </header>
        <main
          id="main"
          key={loc.pathname}
          className="page-in mx-auto max-w-[1200px] p-4 md:p-6"
          tabIndex={-1}
        >
          <Suspense fallback={<Skeleton rows={4} />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
