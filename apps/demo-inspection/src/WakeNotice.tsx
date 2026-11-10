import { useEffect, useState } from 'react';
import { useSyncStatus } from '@syncra/react';

const WAITING = new Set(['connecting', 'authenticating', 'backoff']);

/** The free demo host sleeps when idle; explain a slow first connection instead of showing nothing. */
export function WakeNotice() {
  const { connection } = useSyncStatus();
  const waiting = WAITING.has(connection);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!waiting) {
      setSlow(false);
      return;
    }
    const t = setTimeout(() => {
      setSlow(true);
    }, 3000);
    return () => {
      clearTimeout(t);
    };
  }, [waiting]);
  if (!waiting || !slow) return null;
  return (
    <div role="status" className="wake">
      <strong>Waking the demo server.</strong> The free host sleeps when idle, so this can take up
      to a minute. Your work is saved on this device meanwhile.
      <span aria-hidden="true" className="wake-bar" />
    </div>
  );
}
