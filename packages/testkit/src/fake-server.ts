/**
 * In-process sync server speaking the real wire protocol, for SDK tests. Same observable behaviour
 * as apps/server (per-doc seq, idempotent ops, delta sync, broadcast) minus storage and tenancy.
 */
import * as Y from 'yjs';
import { decodeMessage, encodeMessage, type Message } from '@syncra/protocol';
import { FakeNetwork, Pipe, type FakeSocket } from './network.js';

interface ServerDoc {
  ydoc: Y.Doc;
  seq: number;
  seen: Map<string, number>;
  subs: Set<Conn>;
}

interface Conn {
  pipe: Pipe;
  clientId: string;
  subs: Set<string>;
}

export class FakeServer {
  readonly docs = new Map<string, ServerDoc>();
  readonly conns = new Set<Conn>();
  /** Count of accepted (non-duplicate) update frames, for assertions. */
  acceptedOps = 0;
  /** Total SYNC_STEP2 update bytes sent, to assert delta sync. */
  step2Bytes = 0;
  /** When set, UPDATE frames are answered with this error code instead of being applied. */
  rejectWrites: string | null = null;
  /** When false, new connections are refused before opening (like a 401 on upgrade). */
  acceptConnections = true;

  constructor(readonly network: FakeNetwork = new FakeNetwork()) {}

  /** Transport factory to hand to createClient({ transport }). */
  transport = (url: string, protocols: string[]): FakeSocket => {
    const pipe = new Pipe(this.network);
    this.network.register(pipe);
    const clientId = new URL(url).searchParams.get('clientId') ?? 'anon';
    const hasToken = protocols.some((p) => p.startsWith('syncra.token.'));
    if (this.network.isPartitioned || !this.acceptConnections || !hasToken) {
      queueMicrotask(() => {
        pipe.closed = true;
        pipe.clientSide.onclose?.(1006);
      });
      return pipe.clientSide;
    }
    const conn: Conn = { pipe, clientId, subs: new Set() };
    this.conns.add(conn);
    pipe.onServerFrame = (d) => {
      this.onFrame(conn, d);
    };
    pipe.onServerClose = () => {
      this.drop(conn);
      queueMicrotask(() => pipe.clientSide.onclose?.(1000));
    };
    pipe.establish();
    return pipe.clientSide;
  };

  doc(docKey: string): ServerDoc {
    let d = this.docs.get(docKey);
    if (!d) {
      d = { ydoc: new Y.Doc(), seq: 0, seen: new Map(), subs: new Set() };
      this.docs.set(docKey, d);
    }
    return d;
  }

  /** Current JSON of a server document, for convergence assertions. */
  json(docKey: string): Record<string, unknown> {
    const y = this.doc(docKey).ydoc;
    const out: Record<string, unknown> = {};
    // Root types must be declared before toJSON() can read them (same rule as the real materializer).
    const text = y.getText('text').toJSON();
    const data = y.getMap('data').toJSON();
    const list = y.getArray('list').toJSON();
    if (text) out.text = text;
    if (Object.keys(data).length) out.data = data;
    if (list.length) out.list = list;
    return out;
  }

  /** Close every connection with a protocol close code (e.g. 4010 token expired). */
  closeAll(code: number): void {
    for (const c of [...this.conns]) {
      this.drop(c);
      c.pipe.closeFromServer(code);
    }
  }

  private drop(c: Conn): void {
    this.conns.delete(c);
    for (const k of c.subs) this.docs.get(k)?.subs.delete(c);
  }

  private send(c: Conn, m: Message): void {
    c.pipe.toClient(encodeMessage(m));
  }

  private onFrame(c: Conn, frame: Uint8Array): void {
    const m = decodeMessage(frame);
    switch (m.type) {
      case 'PING':
        this.send(c, { type: 'PONG', docKey: '', timestampMs: m.timestampMs });
        return;
      case 'SUBSCRIBE': {
        const d = this.doc(m.docKey);
        d.subs.add(c);
        c.subs.add(m.docKey);
        this.send(c, { type: 'SUBSCRIBED', docKey: m.docKey, headSeq: d.seq, access: 1 });
        return;
      }
      case 'UNSUBSCRIBE':
        this.doc(m.docKey).subs.delete(c);
        c.subs.delete(m.docKey);
        return;
      case 'SYNC_STEP1': {
        const d = this.doc(m.docKey);
        const update = Y.encodeStateAsUpdate(d.ydoc, m.stateVector);
        this.step2Bytes += update.length;
        this.send(c, { type: 'SYNC_STEP2', docKey: m.docKey, update, seq: d.seq });
        this.send(c, {
          type: 'SYNC_STEP1',
          docKey: m.docKey,
          stateVector: Y.encodeStateVector(d.ydoc),
        });
        return;
      }
      case 'UPDATE': {
        if (this.rejectWrites) {
          this.send(c, {
            type: 'ERROR',
            docKey: m.docKey,
            code: this.rejectWrites,
            message: this.rejectWrites,
            retryAfterMs: 0,
          });
          return;
        }
        const d = this.doc(m.docKey);
        const key = `${c.clientId}\u0000${m.opId}`;
        const prior = d.seen.get(key);
        if (prior !== undefined) {
          this.send(c, { type: 'ACK', docKey: m.docKey, opId: m.opId, seq: prior });
          return;
        }
        Y.applyUpdate(d.ydoc, m.update);
        d.seq++;
        this.acceptedOps++;
        d.seen.set(key, d.seq);
        this.send(c, { type: 'ACK', docKey: m.docKey, opId: m.opId, seq: d.seq });
        const out = encodeMessage({
          type: 'UPDATE_BROADCAST',
          docKey: m.docKey,
          seq: d.seq,
          originClientId: c.clientId,
          update: m.update,
        });
        for (const s of d.subs) if (s !== c) s.pipe.toClient(out);
        return;
      }
      case 'AWARENESS': {
        const d = this.doc(m.docKey);
        const out = encodeMessage(m);
        for (const s of d.subs) if (s !== c) s.pipe.toClient(out);
        return;
      }
      default:
    }
  }
}
