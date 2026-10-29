import type { ChannelLike, LocksLike, TabMessage } from './tabs.js';

export class FakeLocks implements LocksLike {
  private held = new Set<string>();
  private waiting = new Map<string, (() => void)[]>();

  async request(name: string, _o: { mode: 'exclusive' }, cb: () => Promise<void>): Promise<void> {
    if (this.held.has(name))
      await new Promise<void>((r) =>
        this.waiting.set(name, [...(this.waiting.get(name) ?? []), r]),
      );
    this.held.add(name);
    await cb();
    this.held.delete(name);
    this.waiting.get(name)?.shift()?.();
  }
}

export class Bus {
  private chans = new Map<string, Set<FakeChannel>>();
  open(name: string): FakeChannel {
    const c = new FakeChannel(this, name);
    this.chans.set(name, (this.chans.get(name) ?? new Set()).add(c));
    return c;
  }
  deliver(from: FakeChannel, name: string, m: TabMessage): void {
    for (const c of this.chans.get(name) ?? [])
      if (c !== from) queueMicrotask(() => c.onmessage?.({ data: m }));
  }
}
class FakeChannel implements ChannelLike {
  onmessage: ((ev: { data: TabMessage }) => void) | null = null;
  constructor(
    private bus: Bus,
    private name: string,
  ) {}
  postMessage(m: TabMessage): void {
    this.bus.deliver(this, this.name, m);
  }
  close(): void {
    this.onmessage = null;
  }
}
