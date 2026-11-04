/** Auth state: restores the session from the refresh cookie on load, tracks memberships and the active tenant. */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  api,
  onSessionExpired,
  publicPost,
  refreshSession,
  setAccessToken,
  setTenant,
} from './api';

export interface Membership {
  tenantId: string;
  tenantName: string;
  slug: string;
  role: 'owner' | 'admin' | 'developer' | 'viewer';
}
export interface User {
  id: string;
  email: string;
  name: string;
}

interface AuthState {
  status: 'loading' | 'anonymous' | 'authenticated';
  user: User | null;
  memberships: Membership[];
  active: Membership | null;
  login(email: string, password: string): Promise<void>;
  signup(input: {
    email: string;
    password: string;
    name: string;
    tenantName: string;
  }): Promise<{ secretKey: string; publishableKey: string }>;
  acceptInvite(input: { token: string; password?: string; name?: string }): Promise<void>;
  logout(): Promise<void>;
  switchTenant(id: string): void;
}

const Ctx = createContext<AuthState | null>(null);
const TENANT_KEY = 'syncra-dashboard-tenant';

const readStoredTenant = (): string | null => {
  try {
    return localStorage.getItem(TENANT_KEY);
  } catch {
    return null;
  }
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<AuthState['status']>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [activeId, setActiveId] = useState<string | null>(readStoredTenant);

  const activate = useCallback((list: Membership[], preferred: string | null) => {
    const chosen = list.find((m) => m.tenantId === preferred) ?? list[0] ?? null;
    setMemberships(list);
    setActiveId(chosen?.tenantId ?? null);
    setTenant(chosen?.tenantId ?? null);
  }, []);

  const loadMe = useCallback(async () => {
    const me = await api<{ user: User; memberships: Membership[] }>('GET', '/me');
    setUser(me.user);
    activate(me.memberships, readStoredTenant());
    setStatus('authenticated');
  }, [activate]);

  const clear = useCallback(() => {
    setAccessToken(null);
    setTenant(null);
    setUser(null);
    setMemberships([]);
    setStatus('anonymous');
    qc.clear();
  }, [qc]);

  useEffect(() => {
    onSessionExpired(clear);
    void (async () => {
      if (await refreshSession()) await loadMe().catch(clear);
      else setStatus('anonymous');
    })();
  }, [clear, loadMe]);

  const value = useMemo<AuthState>(
    () => ({
      status,
      user,
      memberships,
      active: memberships.find((m) => m.tenantId === activeId) ?? null,
      async login(email, password) {
        const r = await publicPost<{ accessToken: string }>('/auth/login', { email, password });
        setAccessToken(r.accessToken);
        await loadMe();
      },
      async signup(input) {
        const r = await publicPost<{
          accessToken: string;
          keys: { secret: string; publishable: string };
        }>('/auth/signup', input);
        setAccessToken(r.accessToken);
        await loadMe();
        return { secretKey: r.keys.secret, publishableKey: r.keys.publishable };
      },
      async acceptInvite(input) {
        const r = await publicPost<{ accessToken: string }>('/auth/accept-invite', input);
        setAccessToken(r.accessToken);
        await loadMe();
      },
      async logout() {
        await fetch('/v1/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(
          () => undefined,
        );
        clear();
      },
      switchTenant(id) {
        setActiveId(id);
        setTenant(id);
        try {
          localStorage.setItem(TENANT_KEY, id);
        } catch {
          // per-viewer convenience only
        }
        qc.clear();
      },
    }),
    [status, user, memberships, activeId, loadMe, clear, qc],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>');
  return v;
}

export const canWrite = (role?: string): boolean =>
  role === 'owner' || role === 'admin' || role === 'developer';
export const isAdmin = (role?: string): boolean => role === 'owner' || role === 'admin';
