// Compaction effect: write 20,000 small edits to one document, measure how long loading its state takes,
// wait for the worker to snapshot and compact it, then measure again. Both appear in the summary.
import http from 'k6/http';
import { sleep } from 'k6';
import { Trend } from 'k6/metrics';
import { WebSocket } from 'k6/experimental/websockets';
import { BASE, SECRET, mintToken } from './common.js';
import { clockLength, subscribeFrame, textInsertUpdate, updateFrame } from './lib.js';

const loadBefore = new Trend('syncra_state_load_before_ms', true);
const loadAfter = new Trend('syncra_state_load_after_ms', true);
const bytesBefore = new Trend('syncra_state_bytes_before');
const bytesAfter = new Trend('syncra_state_bytes_after');

export const options = { vus: 1, iterations: 1 };

export function setup() {
  return { token: mintToken('k6-compaction') };
}

export default function (data) {
  const docId = `compaction-${Date.now()}`;
  const auth = { headers: { authorization: `Bearer ${SECRET}` } };
  const ws = new WebSocket(
    `${BASE.replace(/^http/, 'ws')}/v1/connect?clientId=k6-compaction&token=${data.token}&v=1`,
  );
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    ws.send(subscribeFrame(`notes/${docId}`));
    let clock = 0;
    for (let i = 0; i < 20_000; i++) {
      ws.send(updateFrame(`notes/${docId}`, `o${i}`, textInsertUpdate(7, clock, 'x')));
      clock += clockLength('x');
    }
    ws.setTimeout(() => ws.close(), 5000);
  };
  sleep(40);
  let r = http.get(`${BASE}/v1/collections/notes/docs/${docId}/state`, auth);
  loadBefore.add(r.timings.duration);
  bytesBefore.add(r.body.byteLength);
  sleep(Number(__ENV.COMPACT_WAIT_S || 90)); // the worker snapshots after 60 s idle and compacts straight after
  r = http.get(`${BASE}/v1/collections/notes/docs/${docId}/state`, auth);
  loadAfter.add(r.timings.duration);
  bytesAfter.add(r.body.byteLength);
}
