import { describe, expect, it } from 'vitest';
import { Bus, FakeLocks } from './tabs.fakes.js';
import { TabCoordinator, type TabEnv } from './tabs.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('TabCoordinator with Web Locks (CLI-06, ADR 0012)', () => {
  it('elects exactly one leader and fails over when the leader goes away', async () => {
    const locks = new FakeLocks();
    const bus = new Bus();
    const env: TabEnv = { locks, channel: (n) => bus.open(n) };
    const state: boolean[] = [false, false, false];
    const tabs = [0, 1, 2].map(
      (i) =>
        new TabCoordinator('t1:u1', env, {
          onLeaderChange: (v) => (state[i] = v),
          onMessage: () => undefined,
        }),
    );
    tabs.forEach((t) => {
      t.start();
    });
    await tick();
    expect(state.filter(Boolean)).toHaveLength(1);
    const leader = state.indexOf(true);
    tabs[leader]?.stop();
    await tick();
    expect(state.filter(Boolean)).toHaveLength(1);
    expect(state.indexOf(true)).not.toBe(leader);
  });

  it('relays messages to other tabs but not back to the sender', async () => {
    const bus = new Bus();
    const env: TabEnv = { locks: new FakeLocks(), channel: (n) => bus.open(n) };
    const got: string[][] = [[], []];
    const mk = (i: number) =>
      new TabCoordinator('t1:u1', env, {
        onLeaderChange: () => undefined,
        onMessage: (m) => got[i]?.push(m.t),
      });
    const [a, b] = [mk(0), mk(1)];
    a.post({ t: 'outbox' });
    await tick();
    expect(got[0]).toEqual([]);
    expect(got[1]).toEqual(['outbox']);
    b.stop();
  });
});

describe('TabCoordinator localStorage fallback', () => {
  it('a tab claims leadership only after the heartbeat is stale (6 s)', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    let now = 0;
    const ticks: (() => void)[][] = [[], []];
    const state = [false, false];
    const bus = new Bus();
    const mk = (i: number) =>
      new TabCoordinator(
        't1:u1',
        {
          storage,
          channel: (n) => bus.open(n),
          now: () => now,
          setInterval: (fn) => ticks[i]?.push(fn),
          clearInterval: () => undefined,
        },
        { onLeaderChange: (v) => (state[i] = v), onMessage: () => undefined },
      );
    const [a, b] = [mk(0), mk(1)];
    a.start();
    b.start();
    expect(state).toEqual([true, false]);

    now = 4000; // leader A is alive and beating
    ticks[0]?.[0]?.();
    ticks[1]?.[0]?.();
    expect(state).toEqual([true, false]);

    now = 11_000; // A stopped beating (tab frozen/killed); B sees a stale heartbeat
    ticks[1]?.[0]?.();
    expect(state[1]).toBe(true);
  });
});
