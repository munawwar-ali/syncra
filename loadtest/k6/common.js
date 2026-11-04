// Shared k6 plumbing: configuration, token minting, and a virtual-user "device" that speaks the Syncra
// protocol. These scenarios have NOT been run in the repository's development environment (no k6 binary
// there); run them with `docker compose --profile loadtest run --rm k6 run /scripts/<scenario>.js`.
import http from 'k6/http';
import { WebSocket } from 'k6/experimental/websockets';
import { Counter, Trend } from 'k6/metrics';
import {
  MSG,
  clockLength,
  findTimestamp,
  pingFrame,
  readHeader,
  subscribeFrame,
  textInsertUpdate,
  updateFrame,
} from './lib.js';

export const BASE = __ENV.SYNCRA_URL || 'http://localhost:8080';
export const WS_BASE = BASE.replace(/^http/, 'ws');
export const SECRET = __ENV.SYNCRA_SECRET_KEY || '';

export const ackLatency = new Trend('syncra_ack_latency_ms', true);
export const propagation = new Trend('syncra_propagation_ms', true);
export const connectTime = new Trend('syncra_connect_ms', true);
export const wsErrors = new Counter('syncra_ws_errors');
export const opsSent = new Counter('syncra_ops_sent');
export const acks = new Counter('syncra_acks');

/** Mints one client token with write access to the `notes` collection. Call from `setup()`. */
export function mintToken(userId) {
  if (!SECRET) throw new Error('set SYNCRA_SECRET_KEY to a tenant secret key (sk_live_...)');
  const res = http.post(
    `${BASE}/v1/tokens`,
    JSON.stringify({
      userId,
      ttlSeconds: 3600,
      access: [{ collection: 'notes', docs: '*', mode: 'rw' }],
    }),
    { headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` } },
  );
  if (res.status !== 200) throw new Error(`token mint failed: ${res.status} ${res.body}`);
  return res.json('token');
}

/** A random client id that fits in 32 bits, like Yjs picks. */
export const newClientId = () => Math.floor(Math.random() * 4_000_000_000) + 1;

/**
 * Opens a connection, subscribes to `docKey`, and optionally writes every `writeEveryMs`.
 * Each write carries a `T<epoch ms>` marker; every other device on the document measures
 * propagation from it. Returns the socket so the caller can close it.
 */
export function device({ token, docKey, writeEveryMs, durationMs, onClose }) {
  const clientId = newClientId();
  const wsClientId = `k6-${clientId}`;
  const started = Date.now();
  const ws = new WebSocket(`${WS_BASE}/v1/connect?clientId=${wsClientId}&token=${token}&v=1`);
  ws.binaryType = 'arraybuffer';
  let clock = 0;
  let n = 0;
  const pending = {};

  ws.onopen = () => {
    connectTime.add(Date.now() - started);
    ws.send(subscribeFrame(docKey));
    ws.setInterval(() => ws.send(pingFrame()), 25_000);
    if (writeEveryMs) {
      ws.setInterval(() => {
        const text = `T${Date.now()}|${n}`;
        const opId = `${wsClientId}:${n++}`;
        pending[opId] = Date.now();
        ws.send(updateFrame(docKey, opId, textInsertUpdate(clientId, clock, text)));
        clock += clockLength(text);
        opsSent.add(1);
      }, writeEveryMs);
    }
    if (durationMs) ws.setTimeout(() => ws.close(), durationMs);
  };

  ws.onmessage = (e) => {
    const buf = new Uint8Array(e.data);
    const h = readHeader(buf);
    if (h.type === MSG.ACK) {
      // fields: opId (varString), seq (varUint)
      let pos = h.offset;
      const len = buf[pos++];
      let opId = '';
      for (let i = 0; i < len; i++) opId += String.fromCharCode(buf[pos + i]);
      if (pending[opId] !== undefined) {
        ackLatency.add(Date.now() - pending[opId]);
        delete pending[opId];
        acks.add(1);
      }
    } else if (h.type === MSG.UPDATE_BROADCAST) {
      const sent = findTimestamp(buf);
      if (sent !== null) propagation.add(Date.now() - sent);
    } else if (h.type === MSG.ERROR) {
      wsErrors.add(1);
    }
  };
  ws.onerror = () => wsErrors.add(1);
  ws.onclose = () => onClose && onClose();
  return ws;
}
