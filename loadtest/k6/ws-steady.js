// Steady state: ramp to N connected devices, each editing a document from a shared pool at 1 update per
// 5 s, against 3 nodes. Records ack latency, cross-client propagation and error rate.
// Usage: k6 run -e SYNCRA_URL=http://nginx -e SYNCRA_SECRET_KEY=sk_live_... -e VUS=1000 ws-steady.js
import { sleep } from 'k6';
import { device, mintToken } from './common.js';

const VUS = Number(__ENV.VUS || 1000);
const DOCS = Math.max(1, Math.floor(VUS / 2)); // about two devices per document so updates fan out

export const options = {
  scenarios: {
    steady: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: VUS },
        { duration: __ENV.HOLD || '5m', target: VUS },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '20s',
    },
  },
  thresholds: {
    syncra_ack_latency_ms: ['p(95)<100'],
    syncra_propagation_ms: ['p(95)<150'],
    syncra_ws_errors: ['count<10'],
  },
};

export function setup() {
  return { token: mintToken('k6-steady') };
}

export default function (data) {
  const docKey = `notes/steady-${Math.floor(Math.random() * DOCS)}`;
  device({ token: data.token, docKey, writeEveryMs: 5000, durationMs: 600_000 });
  sleep(600); // hold the VU open; the socket callbacks do the work
}
