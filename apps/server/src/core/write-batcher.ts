/**
 * Per-document write batcher (Doc 02 §4.3): buffers updates, merges them with Y.mergeUpdates and
 * flushes once per window or size threshold. Each add() resolves only after its batch is flushed,
 * so callers ACK strictly after the durable commit.
 */
import * as Y from 'yjs';

export interface BatchItem {
  clientId: string;
  opId: string;
  update: Uint8Array;
}

export interface Batch {
  docKey: string;
  /** All item updates merged into one. */
  update: Uint8Array;
  items: BatchItem[];
}

export interface WriteBatcherOptions {
  windowMs: number;
  maxBytes: number;
  /** Max documents flushing at once; ready documents are served FIFO so none starves. */
  concurrency?: number;
  flush: (batch: Batch) => Promise<void>;
}

interface Pending extends BatchItem {
  resolve: () => void;
  reject: (e: unknown) => void;
}
interface Buffer {
  items: Pending[];
  bytes: number;
  timer: NodeJS.Timeout | undefined;
}

export class WriteBatcher {
  private readonly buffers = new Map<string, Buffer>();
  private readonly ready: string[] = [];
  private readonly inFlight = new Set<string>();
  private idleWaiters: (() => void)[] = [];
  private readonly concurrency: number;

  constructor(private readonly opts: WriteBatcherOptions) {
    this.concurrency = opts.concurrency ?? 8;
  }

  add(docKey: string, item: BatchItem): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let buf = this.buffers.get(docKey);
      if (!buf) {
        buf = { items: [], bytes: 0, timer: undefined };
        this.buffers.set(docKey, buf);
      }
      buf.items.push({ ...item, resolve, reject });
      buf.bytes += item.update.length;
      if (buf.bytes >= this.opts.maxBytes) this.markReady(docKey);
      else
        buf.timer ??= setTimeout(() => {
          this.markReady(docKey);
        }, this.opts.windowMs);
    });
  }

  /** Flushes everything buffered and waits for all in-flight flushes (graceful shutdown). */
  async drain(): Promise<void> {
    for (const key of this.buffers.keys()) this.markReady(key);
    if (this.isIdle()) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private isIdle(): boolean {
    return this.buffers.size === 0 && this.ready.length === 0 && this.inFlight.size === 0;
  }

  private markReady(docKey: string): void {
    const buf = this.buffers.get(docKey);
    if (!buf) return;
    clearTimeout(buf.timer);
    buf.timer = undefined;
    if (!this.ready.includes(docKey)) this.ready.push(docKey);
    this.pump();
  }

  private pump(): void {
    while (this.inFlight.size < this.concurrency) {
      // A document never flushes concurrently with itself, so its ACKs stay ordered.
      const idx = this.ready.findIndex((k) => !this.inFlight.has(k));
      if (idx < 0) break;
      const [docKey] = this.ready.splice(idx, 1) as [string];
      const buf = this.buffers.get(docKey);
      this.buffers.delete(docKey);
      if (!buf) continue;
      this.inFlight.add(docKey);
      void this.flushOne(docKey, buf.items).finally(() => {
        this.inFlight.delete(docKey);
        this.pump();
        if (this.isIdle())
          this.idleWaiters.splice(0).forEach((w) => {
            w();
          });
      });
    }
  }

  private async flushOne(docKey: string, items: Pending[]): Promise<void> {
    try {
      const first = items[0];
      const update =
        items.length === 1 && first ? first.update : Y.mergeUpdates(items.map((i) => i.update));
      await this.opts.flush({ docKey, update, items });
      items.forEach((i) => {
        i.resolve();
      });
    } catch (e) {
      items.forEach((i) => {
        i.reject(e);
      });
    }
  }
}
