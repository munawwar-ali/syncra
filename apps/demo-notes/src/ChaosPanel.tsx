import { useState } from 'react';
import { useOnlineStatus, useSyncraClient } from '@syncra/react';
import { OFFLINE_KEY, chaos } from './syncra.js';

/** DEM-04: buttons that visibly push the SDK's state machine through its states. */
export function ChaosPanel() {
  const client = useSyncraClient();
  const online = useOnlineStatus();
  const [latency, setLatency] = useState(chaos.latencyMs > 0);
  const [slow, setSlow] = useState(chaos.slowConsumer);

  const toggle = (on: boolean, set: (v: boolean) => void, apply: (v: boolean) => void) => () => {
    set(on);
    apply(on);
  };

  return (
    <section aria-label="Chaos panel">
      <h2 className="mb-1 font-semibold">Chaos panel</h2>
      <p className="mb-3 text-muted">Break the network on purpose and watch the badge.</p>
      <div className="flex flex-col gap-2">
        <button
          data-testid="chaos-offline"
          className="rounded-input border border-line px-3 py-2 text-left hover:bg-surface"
          aria-pressed={!online}
          onClick={() => {
            const goOffline = online;
            sessionStorage.setItem(OFFLINE_KEY, goOffline ? '1' : '0');
            client.simulateOffline(goOffline);
          }}
        >
          {online ? 'Go offline' : 'Go online'}
        </button>
        <button
          className="rounded-input border border-line px-3 py-2 text-left hover:bg-surface"
          aria-pressed={latency}
          onClick={toggle(!latency, setLatency, (v) => (chaos.latencyMs = v ? 2000 : 0))}
        >
          {latency ? 'Remove 2 s latency' : 'Add 2 s latency'}
        </button>
        <button
          className="rounded-input border border-line px-3 py-2 text-left hover:bg-surface"
          onClick={() => client.dropConnection()}
        >
          Drop socket now
        </button>
        <button
          className="rounded-input border border-line px-3 py-2 text-left hover:bg-surface"
          aria-pressed={slow}
          onClick={toggle(!slow, setSlow, (v) => (chaos.slowConsumer = v))}
        >
          {slow ? 'Stop slow consumer' : 'Slow consumer'}
        </button>
      </div>
    </section>
  );
}
