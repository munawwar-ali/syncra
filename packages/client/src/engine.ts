/**
 * SyncEngine (runs in the leader tab only): owns the socket, drives the connection state machine,
 * performs the delta-sync handshake and drains the persisted outbox (Doc 04 §5, Doc 02 §4.2-4.3).
 */
import * as Y from 'yjs';
import { decodeMessage, encodeMessage, type Message } from '@syncra/protocol';
import { backoffDelay, BACKOFF_STABLE_MS } from './backoff.js';
import type { SyncraDoc } from './doc.js';
import { transition, type MachineEvent } from './machine.js';
import type { NetworkMonitor } from './network.js';
import type { LocalStore } from './store.js';
import type { TokenManager } from './token.js';
import type { Socket, Transport } from './transport.js';
import type { ConnectionState, SyncraErrorInfo } from './types.js';

export const PING_INTERVAL_MS = 25_000;
export const PONG_TIMEOUT_MS = 10_000;
export const QUOTA_RETRY_MS = 60_000;
export const AUTH_RETRY_MS = 10_000;
export const OUTBOX_MAX_OPS = 10_000;
export const OUTBOX_MAX_BYTES = 50 * 1024 * 1024;

export interface EngineOptions {
  /** ws:// or wss:// base URL. */
  url: string;
  clientId: string;
  store: LocalStore;
  tokens: TokenManager;
  transport: Transport;
  network: NetworkMonitor;
  nextOpId(): string;
  random?: () => number;
  /** How long to wait in quota-blocked before probing again (default 60 s). */
  quotaRetryMs?: number;
  onState(s: ConnectionState): void;
  onPending(count: number, lastSyncedAt: number | null): void;
  onError(e: SyncraErrorInfo): void;
  onQuota(metric: string): void;
  onQueuePressure(info: { pendingOps: number; pendingBytes: number }): void;
  onDocSynced(doc: SyncraDoc): void;
  onAwareness(docKey: string, update: Uint8Array): void;
}

interface Attached {
  doc: SyncraDoc;
  subscribed: boolean;
  step2: boolean;
  readOnly: boolean;
  blocked: boolean;
}

export class SyncEngine {
  state: ConnectionState = 'idle';
  private sock: Socket | null = null;
  private gen = 0;
  private readonly docs = new Map<string, Attached>();
  private attempt = 0;
  private retryAfterMs = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stableTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private pongTimer: ReturnType<typeof setTimeout> | undefined;
  private draining = false;
  private drainAgain = false;
  private pauseUntil = 0;
  private syncCounter = 0;
  private lastSyncedAt: number | null = null;
  private wanted = false;
  private refreshingToken = false;

  constructor(private readonly o: EngineOptions) {
    o.network.onChange((online) => {
      if (online && this.state === 'backoff') {
        this.attempt = 0;
        this.dispatch({ type: 'TIMER' });
      } else this.dispatch({ type: online ? 'ONLINE' : 'OFFLINE' });
    });
  }

  /** Begin (or resume) connecting. Idempotent. */
  connect(): void {
    this.wanted = true;
    this.dispatch({ type: 'CONNECT', online: this.o.network.online });
  }

  disconnect(): void {
    this.wanted = false;
    this.dispatch({ type: 'DISCONNECT' });
  }

  attach(doc: SyncraDoc): void {
    if (this.docs.has(doc.docKey)) return;
    const e: Attached = { doc, subscribed: false, step2: false, readOnly: false, blocked: false };
    this.docs.set(doc.docKey, e);
    if (this.sockOpen()) this.subscribe(e);
  }

  detach(docKey: string): void {
    if (this.sockOpen()) this.send({ type: 'UNSUBSCRIBE', docKey });
    this.docs.delete(docKey);
  }

  /** Fire-and-forget best effort when local storage failed (not in the outbox). */
  sendVolatile(docKey: string, update: Uint8Array): void {
    const e = this.docs.get(docKey);
    if (this.state === 'live' && e && !e.readOnly) {
      this.send({ type: 'UPDATE', docKey, opId: this.o.nextOpId(), update });
    }
  }

  /** Ask the engine to push any pending outbox entries. */
  requestDrain(): void {
    void this.drain();
  }

  sendAwareness(docKey: string, update: Uint8Array): void {
    if (this.state === 'live' || this.state === 'syncing')
      this.send({ type: 'AWARENESS', docKey, update });
  }

  /** Forces a reconnect (demo "drop socket" and leader hand-over). */
  dropSocket(): void {
    this.sock?.close(1000);
    this.gen++;
    this.sock = null;
    this.dispatch({ type: 'SOCKET_CLOSE', code: 1006 });
  }

  // --- state machine driver -------------------------------------------------------------

  private dispatch(ev: MachineEvent): void {
    const prev = this.state;
    const next = transition(prev, ev);
    if (next === prev) return;
    this.state = next;
    this.o.onState(next);
    this.enter(next, ev);
  }

  private enter(state: ConnectionState, ev: MachineEvent): void {
    clearTimeout(this.stableTimer);
    if (state !== 'live') this.setDocsOffline();
    switch (state) {
      case 'connecting':
        void this.openSocket();
        break;
      case 'backoff':
        this.closeSocket();
        this.schedule(backoffDelay(this.attempt++, this.o.random, this.retryAfterMs));
        this.retryAfterMs = 0;
        break;
      case 'quota-blocked':
        this.closeSocket();
        this.schedule(this.o.quotaRetryMs ?? QUOTA_RETRY_MS);
        break;
      case 'authenticating':
        if (ev.type === 'SOCKET_CLOSE') {
          this.closeSocket();
          void this.refreshToken();
        }
        break;
      case 'auth-expired':
        this.closeSocket();
        this.schedule(AUTH_RETRY_MS, () => void this.refreshToken());
        this.o.onError({ code: 'auth-expired', message: 'Token refresh failed' });
        break;
      case 'live':
        this.stableTimer = setTimeout(() => {
          this.attempt = 0;
        }, BACKOFF_STABLE_MS);
        void this.refreshPending();
        void this.drain();
        break;
      case 'offline':
      case 'idle':
        this.closeSocket();
        clearTimeout(this.timer);
        break;
      case 'error':
        this.closeSocket();
        this.o.onError({ code: 'FORBIDDEN', message: 'Access denied by the server' });
        break;
      case 'syncing':
        break;
    }
  }

  private schedule(ms: number, fn?: () => void): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(
      fn ??
        (() => {
          this.dispatch({ type: 'TIMER' });
        }),
      ms,
    );
  }

  private async refreshToken(): Promise<void> {
    if (this.refreshingToken) return;
    this.refreshingToken = true;
    try {
      this.o.tokens.invalidate();
      await this.o.tokens.get();
      this.dispatch({ type: 'TOKEN_REFRESHED' });
    } catch {
      this.dispatch({ type: 'TOKEN_FAILED' });
      if (this.state === 'auth-expired')
        this.schedule(AUTH_RETRY_MS, () => void this.refreshToken());
    } finally {
      this.refreshingToken = false;
    }
  }

  // --- socket ---------------------------------------------------------------------------

  private sockOpen(): boolean {
    return this.sock !== null && ['authenticating', 'syncing', 'live'].includes(this.state);
  }

  private closeSocket(): void {
    clearInterval(this.pingTimer);
    clearTimeout(this.pongTimer);
    this.gen++;
    const s = this.sock;
    this.sock = null;
    s?.close(1000);
  }

  private async openSocket(): Promise<void> {
    const gen = ++this.gen;
    let token: string;
    try {
      token = await this.o.tokens.get();
    } catch {
      if (gen === this.gen) this.dispatch({ type: 'SOCKET_CLOSE', code: 4001 });
      return;
    }
    if (gen !== this.gen || this.state !== 'connecting') return;
    const url = `${this.o.url.replace(/\/$/, '')}/v1/connect?clientId=${encodeURIComponent(this.o.clientId)}&v=1`;
    const sock = this.o.transport(url, ['syncra.v1', `syncra.token.${token}`]);
    this.sock = sock;
    sock.onopen = () => {
      if (gen !== this.gen) return;
      this.dispatch({ type: 'SOCKET_OPEN' });
      void this.o.store.requeueSent();
      this.startHeartbeat();
      this.send({ type: 'PING', docKey: '', timestampMs: Date.now() });
      for (const e of this.docs.values()) this.subscribe(e);
    };
    sock.onmessage = (data) => {
      if (gen !== this.gen) return;
      let msg: Message;
      try {
        msg = decodeMessage(data);
      } catch {
        return; // a frame we cannot parse is dropped; the connection stays up
      }
      void this.onMessage(msg);
    };
    sock.onclose = (code) => {
      if (gen !== this.gen) return;
      const neverOpened = this.state === 'connecting';
      this.sock = null;
      clearInterval(this.pingTimer);
      clearTimeout(this.pongTimer);
      // A failed upgrade looks like 1006 in browsers; assume a stale token and probe connectivity.
      if (neverOpened) {
        this.o.tokens.invalidate();
        void this.o.network.probe();
      }
      this.dispatch({ type: 'SOCKET_CLOSE', code });
    };
  }

  private startHeartbeat(): void {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      this.send({ type: 'PING', docKey: '', timestampMs: Date.now() });
      clearTimeout(this.pongTimer);
      this.pongTimer = setTimeout(() => {
        this.closeSocket();
        this.dispatch({ type: 'PING_TIMEOUT' });
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  private send(m: Message): void {
    this.sock?.send(encodeMessage(m));
  }

  private subscribe(e: Attached): void {
    e.subscribed = false;
    e.step2 = false;
    e.blocked = false;
    e.doc.setState('syncing');
    this.send({ type: 'SUBSCRIBE', docKey: e.doc.docKey, flags: 0 });
  }

  private setDocsOffline(): void {
    for (const e of this.docs.values()) {
      e.subscribed = false;
      e.step2 = false;
      if (e.doc.state === 'synced' || e.doc.state === 'syncing') e.doc.setState('local-only');
    }
  }

  // --- inbound --------------------------------------------------------------------------

  private async onMessage(msg: Message): Promise<void> {
    const e = this.docs.get(msg.docKey);
    switch (msg.type) {
      case 'PONG':
        clearTimeout(this.pongTimer);
        if (this.state === 'authenticating' && this.docs.size === 0) {
          this.dispatch({ type: 'SUBSCRIBED' });
          this.dispatch({ type: 'ALL_SYNCED' });
        }
        return;
      case 'SUBSCRIBED':
        if (!e) return;
        e.subscribed = true;
        e.readOnly = msg.access === 0;
        this.send({
          type: 'SYNC_STEP1',
          docKey: msg.docKey,
          stateVector: Y.encodeStateVector(e.doc.ydoc),
        });
        this.dispatch({ type: 'SUBSCRIBED' });
        return;
      case 'SYNC_STEP2':
        if (!e) return;
        e.doc.applyRemote(msg.update);
        e.step2 = true;
        e.doc.setState('synced');
        this.o.onDocSynced(e.doc);
        this.checkAllSynced();
        return;
      case 'SYNC_STEP1': {
        if (!e) return;
        const extra = Y.encodeStateAsUpdate(e.doc.ydoc, msg.stateVector);
        if (extra.length > 2) {
          const opId = `sync:${this.o.clientId}:${String(this.syncCounter++)}`;
          this.send({ type: 'UPDATE', docKey: msg.docKey, opId, update: extra });
        }
        return;
      }
      case 'UPDATE_BROADCAST':
        e?.doc.applyRemote(msg.update);
        return;
      case 'AWARENESS':
        e?.doc.applyAwareness(msg.update, 'remote');
        return;
      case 'ACK':
        await this.o.store.ack(msg.opId);
        await this.refreshPending();
        return;
      case 'RESYNC_HINT':
        if (e)
          this.send({
            type: 'SYNC_STEP1',
            docKey: msg.docKey,
            stateVector: Y.encodeStateVector(e.doc.ydoc),
          });
        return;
      case 'ERROR':
        await this.onServerError(msg, e);
        return;
      default:
    }
  }

  private checkAllSynced(): void {
    const all = [...this.docs.values()].every((d) => d.step2 || d.blocked);
    if (!all) return;
    if (this.state === 'syncing') this.dispatch({ type: 'ALL_SYNCED' });
    else if (this.state === 'live') void this.drain();
  }

  private async onServerError(
    msg: Extract<Message, { type: 'ERROR' }>,
    e: Attached | undefined,
  ): Promise<void> {
    const info = { code: msg.code, message: msg.message };
    switch (msg.code) {
      case 'QUOTA_EXCEEDED':
        await this.o.store.requeueSent();
        e?.doc.setState('blocked');
        this.o.onQuota(msg.message);
        this.dispatch({ type: 'QUOTA' });
        return;
      case 'FORBIDDEN':
      case 'NOT_FOUND':
        if (e) {
          e.blocked = true;
          e.doc.setState('blocked');
          this.checkAllSynced();
        }
        this.o.onError(info);
        return;
      case 'RATE_LIMITED':
      case 'UNAVAILABLE': {
        const wait = Math.max(msg.retryAfterMs, msg.code === 'UNAVAILABLE' ? 5000 : 500);
        this.pauseUntil = Date.now() + wait;
        await this.o.store.requeueSent();
        setTimeout(() => void this.drain(), wait);
        return;
      }
      default:
        this.o.onError(info);
    }
  }

  // --- outbox ---------------------------------------------------------------------------

  async refreshPending(): Promise<void> {
    const n = await this.o.store.outboxCount();
    if (n === 0 && this.state === 'live') this.lastSyncedAt = Date.now();
    this.o.onPending(n, this.lastSyncedAt);
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      this.drainAgain = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.drainAgain = false;
        await this.drainOnce();
      } while (this.drainAgain);
    } finally {
      this.draining = false;
    }
  }

  private async drainOnce(): Promise<void> {
    if (this.state !== 'live' || !this.sock || Date.now() < this.pauseUntil) return;
    const entries = await this.o.store.outbox();
    const bytes = entries.reduce((n, x) => n + x.update.length, 0);
    const pressure = entries.length > OUTBOX_MAX_OPS || bytes > OUTBOX_MAX_BYTES;
    if (pressure) this.o.onQueuePressure({ pendingOps: entries.length, pendingBytes: bytes });

    const byDoc = new Map<string, typeof entries>();
    for (const x of entries) {
      if (x.state === 'pending') byDoc.set(x.docKey, [...(byDoc.get(x.docKey) ?? []), x]);
    }
    for (const [docKey, list] of byDoc) {
      const e = this.docs.get(docKey);
      if (!e?.step2 || e.readOnly || e.blocked) continue;
      let toSend = list;
      if (list.length > 1) {
        // Merging CRDT updates is always safe; it keeps the outbox small and sends one frame.
        const merged = {
          opId: this.o.nextOpId(),
          docKey,
          update: Y.mergeUpdates(list.map((x) => x.update)),
          createdAt: Math.min(...list.map((x) => x.createdAt)),
          attempts: 0,
          state: 'pending' as const,
        };
        await this.o.store.replaceOutbox(
          list.map((x) => x.opId),
          merged,
        );
        toSend = [merged];
      }
      for (const x of toSend) {
        this.send({ type: 'UPDATE', docKey, opId: x.opId, update: x.update });
      }
      await this.o.store.markSent(toSend.map((x) => x.opId));
    }
  }
}
