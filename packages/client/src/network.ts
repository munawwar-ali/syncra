/** Online/offline detection (CLI-05): browser events plus an optional active probe. */

export interface NetworkOptions {
  /** URL fetched (HEAD) to confirm real connectivity; omit to rely on events only. */
  probeUrl?: string;
}

export class NetworkMonitor {
  private forcedOffline = false;
  private probeFailed = false;
  private readonly listeners = new Set<(online: boolean) => void>();
  private last: boolean;
  private readonly onOnline = (): void => {
    this.probeFailed = false;
    this.publish();
  };
  private readonly onOffline = (): void => {
    this.publish();
  };

  constructor(private readonly o: NetworkOptions = {}) {
    this.last = this.online;
  }

  get online(): boolean {
    // Node and workers expose navigator without onLine; treat that as online.
    const nav = typeof navigator === 'undefined' ? true : (navigator.onLine ?? true);
    return nav && !this.forcedOffline && !this.probeFailed;
  }

  start(): void {
    globalThis.addEventListener?.('online', this.onOnline);
    globalThis.addEventListener?.('offline', this.onOffline);
  }

  stop(): void {
    globalThis.removeEventListener?.('online', this.onOnline);
    globalThis.removeEventListener?.('offline', this.onOffline);
  }

  onChange(cb: (online: boolean) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Demo/test switch (SyncraClient.simulateOffline). */
  setForcedOffline(on: boolean): void {
    this.forcedOffline = on;
    this.publish();
  }

  /** Active check after a failed connect; marks us offline until the next success. */
  async probe(): Promise<boolean> {
    if (!this.o.probeUrl) return this.online;
    try {
      await fetch(this.o.probeUrl, { method: 'HEAD', cache: 'no-store' });
      this.probeFailed = false;
    } catch {
      this.probeFailed = true;
      // Keep checking: no browser event fires when connectivity quietly returns.
      setTimeout(() => void this.probe(), 5000).unref?.();
    }
    this.publish();
    return this.online;
  }

  private publish(): void {
    const now = this.online;
    if (now === this.last) return;
    this.last = now;
    for (const cb of this.listeners) cb(now);
  }
}
