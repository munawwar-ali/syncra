// Reconnect storm: 2,000 connected devices; while this runs, stop one node (loadtest/chaos/kill-node.sh).
// Devices reconnect with full jitter like the SDK does. Records how long each reconnect took.
// Lost acknowledged updates are checked afterwards by comparing syncra_acks with the server's op rows.
import { sleep } from 'k6';
import { device, mintToken } from './common.js';

export const options = {
  scenarios: {
    storm: {
      executor: 'constant-vus',
      vus: Number(__ENV.VUS || 2000),
      duration: __ENV.DURATION || '4m',
    },
  },
  thresholds: { syncra_connect_ms: ['p(95)<5000'] },
};

export function setup() {
  return { token: mintToken('k6-storm') };
}

export default function (data) {
  const docKey = `notes/storm-${Math.floor(Math.random() * 1000)}`;
  let attempt = 0;
  const open = () =>
    device({
      token: data.token,
      docKey,
      writeEveryMs: 5000,
      durationMs: 0,
      onClose: () => {
        attempt += 1;
        const ceiling = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
        setTimeout(open, Math.random() * ceiling); // full jitter, base 500 ms, cap 30 s
      },
    });
  open();
  sleep(Number(__ENV.HOLD_S || 230));
}
