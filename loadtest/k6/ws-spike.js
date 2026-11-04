// Spike: jump from 100 to 2,000 devices in 10 s and see how the cluster recovers.
import { sleep } from 'k6';
import { device, mintToken } from './common.js';

export const options = {
  scenarios: {
    spike: {
      executor: 'ramping-vus',
      startVUs: 100,
      stages: [
        { duration: '30s', target: 100 },
        { duration: '10s', target: 2000 },
        { duration: '2m', target: 2000 },
        { duration: '30s', target: 100 },
      ],
    },
  },
  thresholds: { syncra_ws_errors: ['count<50'], syncra_connect_ms: ['p(95)<3000'] },
};

export function setup() {
  return { token: mintToken('k6-spike') };
}

export default function (data) {
  device({
    token: data.token,
    docKey: `notes/spike-${Math.floor(Math.random() * 1000)}`,
    writeEveryMs: 5000,
    durationMs: 120_000,
  });
  sleep(120);
}
