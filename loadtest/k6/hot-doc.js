// Hot document: one document with many subscribers and a few writers. Stresses fan-out, the
// per-document write lock and outbound backpressure.
// Usage: k6 run -e SYNCRA_URL=... -e SYNCRA_SECRET_KEY=... -e SUBSCRIBERS=500 hot-doc.js
import { sleep } from 'k6';
import { device, mintToken } from './common.js';

const SUBSCRIBERS = Number(__ENV.SUBSCRIBERS || 500);
const WRITERS = 10;

export const options = {
  scenarios: {
    readers: {
      executor: 'ramping-vus',
      exec: 'reader',
      startVUs: 0,
      stages: [
        { duration: '1m', target: SUBSCRIBERS },
        { duration: '3m', target: SUBSCRIBERS },
      ],
    },
    writers: {
      executor: 'constant-vus',
      exec: 'writer',
      vus: WRITERS,
      duration: '4m',
      startTime: '1m',
    },
  },
  thresholds: { syncra_propagation_ms: ['p(95)<250'], syncra_ws_errors: ['count<10'] },
};

export function setup() {
  return { token: mintToken('k6-hot') };
}

export function reader(data) {
  device({ token: data.token, docKey: 'notes/hot', durationMs: 230_000 });
  sleep(230);
}

export function writer(data) {
  // 5 updates per second per writer
  device({ token: data.token, docKey: 'notes/hot', writeEveryMs: 200, durationMs: 180_000 });
  sleep(180);
}
