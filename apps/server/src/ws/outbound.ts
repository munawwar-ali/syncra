/**
 * Per-connection outbound backpressure (OPS-02, Doc 02 §9.2). Above the high-water mark broadcasts stop
 * being written to the socket and are coalesced per document with Y.mergeUpdates, so memory stays
 * bounded by document count rather than traffic. When the buffer drains the merged updates go out; if
 * the consumer stays slow past the limit the socket is closed with 1013 and the client delta-syncs.
 */
import * as Y from 'yjs';
import { CLOSE_CODES, encodeMessage } from '@syncra/protocol';

export interface SocketLike {
  readonly bufferedAmount: number;
  readonly readyState: number;
  send(data: Uint8Array): void;
  close(code: number, reason: string): void;
}

export type BackpressureEvent = 'slow' | 'resumed' | 'closed';

export interface OutboundOptions {
  highWater: number;
  slowCloseMs: number;
  /** How often a slow connection is checked for draining. */
  checkMs?: number;
  now?: () => number;
  onEvent?: (e: BackpressureEvent) => void;
}

const OPEN = 1;

export class Outbound {
  private pending = new Map<string, { seq: number; update: Uint8Array }>();
  private slowSince: number | null = null;
  private timer: NodeJS.Timeout | undefined;
  private readonly now: () => number;

  constructor(
    private readonly ws: SocketLike,
    private readonly o: OutboundOptions,
  ) {
    this.now = o.now ?? Date.now;
  }

  get isSlow(): boolean {
    return this.slowSince !== null;
  }

  /** Documents whose updates are currently being held back. */
  get pendingDocs(): number {
    return this.pending.size;
  }

  /** Control frames (ACK, ERROR, PONG, ...) are small and always sent. */
  send(frame: Uint8Array): void {
    if (this.ws.readyState === OPEN) this.ws.send(frame);
  }

  /** Ephemeral frames (awareness) are simply dropped for a slow consumer. */
  sendEphemeral(frame: Uint8Array): void {
    if (!this.isSlow && this.ws.bufferedAmount <= this.o.highWater) this.send(frame);
  }

  /** A document update from another client. Held and merged while the consumer is slow. */
  broadcast(docKey: string, seq: number, originClientId: string, update: Uint8Array): void {
    if (this.ws.readyState !== OPEN) return;
    if (!this.isSlow && this.ws.bufferedAmount > this.o.highWater) this.enterSlow();
    if (this.isSlow) {
      const held = this.pending.get(docKey);
      this.pending.set(docKey, {
        seq: Math.max(seq, held?.seq ?? 0),
        update: held ? Y.mergeUpdates([held.update, update]) : update,
      });
      return;
    }
    this.ws.send(encodeMessage({ type: 'UPDATE_BROADCAST', docKey, seq, originClientId, update }));
  }

  private enterSlow(): void {
    this.slowSince = this.now();
    this.o.onEvent?.('slow');
    this.timer = setInterval(() => {
      this.check();
    }, this.o.checkMs ?? 100);
    this.timer.unref();
  }

  /** Called on a timer while slow; exposed for tests. */
  check(): void {
    if (this.slowSince === null) return;
    if (this.ws.readyState !== OPEN) {
      this.dispose();
      return;
    }
    if (this.ws.bufferedAmount <= this.o.highWater / 2) {
      const held = this.pending;
      this.pending = new Map();
      this.slowSince = null;
      clearInterval(this.timer);
      this.o.onEvent?.('resumed');
      for (const [docKey, h] of held) {
        // seq is the highest merged; the origin is unknown after merging, which clients tolerate
        this.broadcast(docKey, h.seq, 'multi', h.update);
      }
      return;
    }
    if (this.now() - this.slowSince >= this.o.slowCloseMs) {
      this.o.onEvent?.('closed');
      this.dispose();
      this.ws.close(CLOSE_CODES.TRY_AGAIN_LATER, 'slow consumer');
    }
  }

  dispose(): void {
    clearInterval(this.timer);
    this.pending.clear();
    this.slowSince = null;
  }
}
