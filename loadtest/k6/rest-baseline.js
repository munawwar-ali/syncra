// REST baseline: token minting and document reads, to size the HTTP side separately from WebSockets.
import http from 'k6/http';
import { check } from 'k6';
import { BASE, SECRET } from './common.js';

export const options = {
  scenarios: {
    rest: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 200),
      timeUnit: '1s',
      duration: '2m',
      preAllocatedVUs: 100,
      maxVUs: 400,
    },
  },
  thresholds: { http_req_duration: ['p(95)<200'], http_req_failed: ['rate<0.01'] },
};

export function setup() {
  const auth = {
    headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
  };
  for (let i = 0; i < 50; i++) {
    http.post(
      `${BASE}/v1/collections/rest/docs`,
      JSON.stringify({ id: `d${i}`, initial: { n: i } }),
      auth,
    );
  }
  return auth;
}

export default function (auth) {
  const mint = Math.random() < 0.2;
  const res = mint
    ? http.post(
        `${BASE}/v1/tokens`,
        JSON.stringify({
          userId: 'u',
          ttlSeconds: 600,
          access: [{ collection: 'rest', docs: '*', mode: 'r' }],
        }),
        auth,
      )
    : http.get(`${BASE}/v1/collections/rest/docs/d${Math.floor(Math.random() * 50)}`, auth);
  check(res, { ok: (x) => x.status === 200 });
}
