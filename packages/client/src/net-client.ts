/**
 * Minimal network client (Phase 1): one multiplexed WebSocket, in-memory Y.Docs, no reconnect.
 * Phase 2 wraps this in the persistent, offline-first runtime.
 */
import * as Y from 'yjs';
import { decodeMessage, encodeMessage, type Message } from '@syncra/protocol';

export interface NetClientOptions {
  /** ws:// or wss:// base URL of the server. */
  url: string;
  token: string;
  clientId?: string;
}

export interface DocError {
  code: string;
  message: string;
}

const REMOTE = Symbol('remote');

export class NetDoc {
  readonly ydoc = new Y.Doc();
  /** Size of the first SYNC_STEP2 update received: the delta the server had to send. */
  syncStep2Bytes = 0;
  readonly errors: DocError[] = [];
  private subscribed = false;
  private readonly queue: Uint8Array[] = [];
  private readonly pending = new Map<
    string,
    { resolve: () => void; reject: (e: Error) => void; promise: Promise<void> }
  >();
  private markSynced!: () => void;
  private readonly synced = new Promise<void>((r) => (this.markSynced = r));

  constructor(
    private readonly client: NetClient,
    readonly collection: string,
    readonly id: string,
  ) {
    this.ydoc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== REMOTE) void this.sendUpdate(this.client.nextOpId(), update);
    });
  }

  get docKey(): string {
    return `${this.collection}/${this.id}`;
  }

  whenSynced(): Promise<void> {
    return this.synced;
  }

  /** Resolves once every update sent so far has been ACKed by the server. */
  async flush(): Promise<void> {
    await Promise.all([...this.pending.values()].map((p) => p.promise));
  }

  /** @internal */
  sendUpdate(opId: string, update: Uint8Array): Promise<void> {
    const frame = encodeMessage({ type: 'UPDATE', docKey: this.docKey, opId, update });
    let entry!: { resolve: () => void; reject: (e: Error) => void };
    const done = new Promise<void>((resolve, reject) => {
      entry = { resolve, reject };
    });
    done.catch(() => undefined);
    this.pending.set(opId, { ...entry, promise: done });
    if (this.subscribed) this.client.sendRaw(frame);
    else this.queue.push(frame);
    return done;
  }

  /** @internal */
  onMessage(msg: Message): void {
    switch (msg.type) {
      case 'SUBSCRIBED':
        this.subscribed = true;
        this.client.sendRaw(
          encodeMessage({
            type: 'SYNC_STEP1',
            docKey: this.docKey,
            stateVector: Y.encodeStateVector(this.ydoc),
          }),
        );
        for (const f of this.queue.splice(0)) this.client.sendRaw(f);
        return;
      case 'SYNC_STEP2':
        this.syncStep2Bytes ||= msg.update.length;
        Y.applyUpdate(this.ydoc, msg.update, REMOTE);
        this.markSynced();
        return;
      case 'SYNC_STEP1':
        // Server's state vector: send whatever it lacks. Always sent so the ACK clears the handshake.
        void this.sendUpdate(
          `sync:${this.client.clientId}:${String(this.client.counter++)}`,
          Y.encodeStateAsUpdate(this.ydoc, msg.stateVector),
        );
        return;
      case 'UPDATE_BROADCAST':
        Y.applyUpdate(this.ydoc, msg.update, REMOTE);
        return;
      case 'ACK':
        this.pending.get(msg.opId)?.resolve();
        this.pending.delete(msg.opId);
        return;
      case 'ERROR':
        this.errors.push({ code: msg.code, message: msg.message });
        for (const p of this.pending.values()) p.reject(new Error(msg.code));
        this.pending.clear();
        return;
      default:
    }
  }

  /** @internal */
  subscribeFrame(readOnly: boolean): Uint8Array {
    return encodeMessage({ type: 'SUBSCRIBE', docKey: this.docKey, flags: readOnly ? 1 : 0 });
  }
}

export class NetClient {
  readonly clientId: string;
  counter = 0;
  /** Total bytes of frames received, for delta-sync assertions. */
  bytesReceived = 0;
  private readonly ws: WebSocket;
  private readonly docs = new Map<string, NetDoc>();
  private readonly opened: Promise<void>;
  private readonly outbound: Uint8Array[] = [];

  constructor(opts: NetClientOptions) {
    this.clientId = opts.clientId ?? crypto.randomUUID();
    const url = new URL('/v1/connect', opts.url);
    url.searchParams.set('clientId', this.clientId);
    url.searchParams.set('token', opts.token);
    url.searchParams.set('v', '1');
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => {
        for (const f of this.outbound.splice(0)) this.ws.send(f);
        resolve();
      });
      this.ws.addEventListener('error', () => {
        reject(new Error('connection failed'));
      });
    });
    this.opened.catch(() => undefined);
    this.ws.addEventListener('message', (ev: MessageEvent<ArrayBuffer>) => {
      const frame = new Uint8Array(ev.data);
      this.bytesReceived += frame.length;
      const msg = decodeMessage(frame);
      this.docs.get(msg.docKey)?.onMessage(msg);
    });
  }

  nextOpId(): string {
    return `${this.clientId}:${String(this.counter++)}`;
  }

  whenOpen(): Promise<void> {
    return this.opened;
  }

  /** Opens a document and starts syncing it. */
  doc(collection: string, id: string, opts: { readOnly?: boolean } = {}): NetDoc {
    const key = `${collection}/${id}`;
    let d = this.docs.get(key);
    if (!d) {
      d = new NetDoc(this, collection, id);
      this.docs.set(key, d);
      this.sendRaw(d.subscribeFrame(opts.readOnly ?? false));
    }
    return d;
  }

  /** @internal */
  sendRaw(frame: Uint8Array): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(frame);
    else this.outbound.push(frame);
  }

  close(): void {
    this.ws.close();
  }
}
