/** Simulated network between SDK clients and the fake server (latency, jitter, loss, duplication, reordering, partitions). */

/** Structurally identical to the client's Socket so this package needs no dependency on it. */
export interface FakeSocket {
  send(data: Uint8Array): void;
  close(code?: number): void;
  onopen: (() => void) | null;
  onmessage: ((data: Uint8Array) => void) | null;
  onclose: ((code: number) => void) | null;
}

export interface NetworkConditions {
  latencyMs: number;
  jitterMs: number;
  /** Probability a frame silently disappears. */
  dropRate: number;
  /** Probability a frame is delivered twice. */
  duplicateRate: number;
  /** Probability a frame is held back extra so it arrives after later frames. */
  reorderRate: number;
}

export const CLEAN: NetworkConditions = {
  latencyMs: 0,
  jitterMs: 0,
  dropRate: 0,
  duplicateRate: 0,
  reorderRate: 0,
};

export type Direction = 'up' | 'down';

/** One end of a client<->server link. */
export class Pipe {
  open = false;
  closed = false;
  clientSide: FakeSocket;
  onServerFrame: ((d: Uint8Array) => void) | null = null;
  onServerClose: ((code: number) => void) | null = null;

  constructor(private readonly net: FakeNetwork) {
    this.clientSide = {
      onopen: null,
      onmessage: null,
      onclose: null,
      send: (d) => {
        this.net.deliver(() => this.onServerFrame?.(d), this, 'up');
      },
      close: (code = 1000) => {
        if (this.closed) return;
        this.closed = true;
        this.net.deliver(() => this.onServerClose?.(code), this, 'up', true);
      },
    };
  }

  /** Server -> client frame. */
  toClient(d: Uint8Array): void {
    this.net.deliver(() => this.clientSide.onmessage?.(d), this, 'down');
  }

  /** Server closes the connection. */
  closeFromServer(code: number): void {
    if (this.closed) return;
    this.closed = true;
    this.net.deliver(() => this.clientSide.onclose?.(code), this, 'down', true);
  }

  /** Marks the link established. */
  establish(): void {
    this.open = true;
    queueMicrotask(() => this.clientSide.onopen?.());
  }
}

export class FakeNetwork {
  conditions: NetworkConditions;
  private partitioned = false;
  private readonly pipes = new Set<Pipe>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    conditions: Partial<NetworkConditions> = {},
    private readonly random: () => number = Math.random,
  ) {
    this.conditions = { ...CLEAN, ...conditions };
  }

  get isPartitioned(): boolean {
    return this.partitioned;
  }

  register(p: Pipe): void {
    this.pipes.add(p);
  }

  /** While partitioned, every link is cut and new connections fail immediately. */
  partition(on: boolean): void {
    this.partitioned = on;
    if (!on) return;
    for (const p of this.pipes) {
      if (!p.closed) {
        p.closed = true;
        queueMicrotask(() => p.clientSide.onclose?.(1006));
      }
    }
    this.pipes.clear();
  }

  /** Cut all current links without blocking new ones (a "dropped socket"). */
  dropAll(): void {
    for (const p of this.pipes) {
      if (!p.closed) {
        p.closed = true;
        queueMicrotask(() => p.clientSide.onclose?.(1006));
      }
    }
    this.pipes.clear();
  }

  /** Schedules a delivery under the current conditions. `reliable` skips loss/duplication. */
  deliver(fn: () => void, pipe: Pipe, _dir: Direction, reliable = false): void {
    if (this.partitioned && !reliable) return;
    const c = this.conditions;
    if (!reliable && this.random() < c.dropRate) return;
    const copies = !reliable && this.random() < c.duplicateRate ? 2 : 1;
    for (let i = 0; i < copies; i++) {
      let delay = c.latencyMs + this.random() * c.jitterMs;
      if (!reliable && this.random() < c.reorderRate) delay += c.latencyMs + c.jitterMs + 5;
      const t = setTimeout(() => {
        this.timers.delete(t);
        if (!pipe.closed || reliable) fn();
      }, delay);
      this.timers.add(t);
    }
  }

  dispose(): void {
    this.timers.forEach((t) => {
      clearTimeout(t);
    });
    this.timers.clear();
  }
}
