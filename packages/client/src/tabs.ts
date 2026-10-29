/**
 * Multi-tab coordination (Doc 04 §7): leader election (Web Locks, with a localStorage heartbeat
 * fallback) and a typed BroadcastChannel relay. Everything platform-specific is injectable.
 */
import type { SyncStatus } from './types.js';

export type TabMessage =
  | { t: 'update'; docKey: string; update: Uint8Array; from: string }
  | { t: 'aw'; docKey: string; update: Uint8Array; from: string }
  | { t: 'sv'; docKey: string; sv: Uint8Array; from: string }
  | { t: 'open'; docKey: string; from: string }
  | { t: 'close'; docKey: string; from: string }
  | { t: 'announce'; from: string }
  | { t: 'outbox'; from: string }
  | { t: 'status'; status: SyncStatus; from: string };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface ChannelLike {
  postMessage(m: TabMessage): void;
  onmessage: ((ev: { data: TabMessage }) => void) | null;
  close(): void;
}

export interface LocksLike {
  request(name: string, opts: { mode: 'exclusive' }, cb: () => Promise<void>): Promise<void>;
}

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export interface TabEnv {
  locks?: LocksLike;
  storage?: StorageLike;
  channel: (name: string) => ChannelLike;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
}

/** Environment from the current browser; fields are undefined where the API is missing. */
export function browserTabEnv(): TabEnv {
  const g = globalThis as unknown as {
    navigator?: { locks?: LocksLike };
    localStorage?: StorageLike;
    BroadcastChannel?: new (n: string) => ChannelLike;
  };
  return {
    locks: g.navigator?.locks,
    storage: g.localStorage,
    channel: (name) => {
      if (!g.BroadcastChannel) throw new Error('BroadcastChannel unavailable');
      return new g.BroadcastChannel(name);
    },
  };
}

const HEARTBEAT_MS = 2000;
const STALE_MS = 6000;

export class TabCoordinator {
  readonly tabId = Math.random().toString(36).slice(2, 10);
  private readonly channel: ChannelLike;
  private releaseLock: (() => void) | null = null;
  private timer: unknown;
  private leader = false;
  private stopped = false;

  constructor(
    private readonly name: string,
    private readonly env: TabEnv,
    private readonly h: {
      onLeaderChange: (isLeader: boolean) => void;
      onMessage: (m: TabMessage) => void;
    },
  ) {
    this.channel = env.channel(`syncra:${name}`);
    this.channel.onmessage = (ev) => {
      if (ev.data.from !== this.tabId) h.onMessage(ev.data);
    };
  }

  get isLeader(): boolean {
    return this.leader;
  }

  post(m: DistributiveOmit<TabMessage, 'from'>): void {
    this.channel.postMessage({ ...m, from: this.tabId });
  }

  start(): void {
    if (this.env.locks) this.startWithLocks(this.env.locks);
    else this.startWithHeartbeat();
  }

  stop(): void {
    this.stopped = true;
    this.releaseLock?.();
    if (this.timer !== undefined) (this.env.clearInterval ?? clearInterval)(this.timer as never);
    if (this.leader && this.env.storage) {
      const cur = this.read();
      if (cur?.tabId === this.tabId) this.env.storage.removeItem(this.key);
    }
    this.setLeader(false);
    this.channel.close();
  }

  private setLeader(v: boolean): void {
    if (this.leader === v) return;
    this.leader = v;
    this.h.onLeaderChange(v);
  }

  private startWithLocks(locks: LocksLike): void {
    void locks.request(`syncra:leader:${this.name}`, { mode: 'exclusive' }, () => {
      if (this.stopped) return Promise.resolve();
      this.setLeader(true);
      // Holding the promise open holds the lock; it is released when the tab closes or stop() runs.
      return new Promise<void>((release) => {
        this.releaseLock = release;
      });
    });
  }

  private get key(): string {
    return `syncra:leader:${this.name}`;
  }

  private read(): { tabId: string; ts: number } | null {
    try {
      return JSON.parse(this.env.storage?.getItem(this.key) ?? 'null') as {
        tabId: string;
        ts: number;
      } | null;
    } catch {
      return null;
    }
  }

  /** Fallback for browsers without Web Locks: claim when the heartbeat is older than 6 s. */
  private startWithHeartbeat(): void {
    const now = this.env.now ?? Date.now;
    const tick = (): void => {
      const cur = this.read();
      if (cur?.tabId === this.tabId || !cur || now() - cur.ts > STALE_MS) {
        this.env.storage?.setItem(this.key, JSON.stringify({ tabId: this.tabId, ts: now() }));
        // Re-read to settle a simultaneous claim: the last writer wins, the other steps down.
        this.setLeader(this.read()?.tabId === this.tabId);
      } else {
        this.setLeader(false);
      }
    };
    tick();
    this.timer = (this.env.setInterval ?? setInterval)(tick, HEARTBEAT_MS);
  }
}
