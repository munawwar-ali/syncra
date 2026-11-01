import { useEffect, useState } from 'react';
import { useSyncStatus } from '@syncra/react';

type Look = { label: string; dot: string; pulse?: boolean };

const LOOKS: Record<string, Look> = {
  live: { label: 'Synced', dot: 'var(--success)' },
  syncing: { label: 'Syncing', dot: '#2563eb', pulse: true },
  connecting: { label: 'Syncing', dot: '#2563eb', pulse: true },
  authenticating: { label: 'Syncing', dot: '#2563eb', pulse: true },
  offline: { label: 'Offline - changes saved on this device', dot: 'var(--offline)' },
  backoff: { label: 'Reconnecting', dot: 'var(--warning)' },
  'quota-blocked': { label: 'Paused: plan limit', dot: 'var(--warning)' },
  'auth-expired': { label: 'Signed out - sign in again', dot: 'var(--danger)' },
  error: { label: 'Sync error', dot: 'var(--danger)' },
  idle: { label: 'Not connected', dot: 'var(--offline)' },
};

function ago(ms: number | null, now: number): string {
  if (ms === null) return 'never';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${String(s)} s ago`;
  return `${String(Math.round(s / 60))} min ago`;
}

export function SyncBadge() {
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
  const look: Look = LOOKS[s.connection] ?? { label: 'Not connected', dot: 'var(--offline)' };
  return (
    <div className="flex items-center gap-3" role="status" aria-live="polite">
      <span data-testid="sync-badge" data-state={s.connection} className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className={`inline-block h-2.5 w-2.5 rounded-full ${look.pulse ? 'pulse' : ''}`}
          style={{ background: look.dot }}
        />
        {look.label}
      </span>
      <span data-testid="pending" className="text-muted">
        {s.pendingOps} pending
      </span>
      <span className="text-muted">Last synced {ago(s.lastSyncedAt, now)}</span>
    </div>
  );
}
