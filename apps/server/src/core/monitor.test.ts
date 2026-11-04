import { describe, expect, it } from 'vitest';
import { Monitor } from './monitor.js';

function make() {
  let t = 1_000_000;
  const m = new Monitor(
    () => ({ connections: 7, hotDocs: 3 }),
    (tid) => (tid === 'a' ? 2 : 0),
    () => t,
  );
  return { m, advance: (ms: number) => (t += ms) };
}

describe('Monitor (DSH-02)', () => {
  it('turns counters into per-second rates, scoped per tenant', () => {
    const { m, advance } = make();
    for (let i = 0; i < 30; i++) m.countOp('a');
    for (let i = 0; i < 10; i++) m.countOp('b');
    advance(1000);
    m.tick(1000);
    expect(m.view('a', false)).toMatchObject({ opsPerSec: 30, connections: 2 });
    expect(m.view('b', false).opsPerSec).toBe(10);
    expect(m.view('a', false)).not.toHaveProperty('system');
    expect(m.view('a', true).system).toEqual({ opsPerSec: 40, connections: 7, hotDocs: 3 });
    m.tick(1000);
    expect(m.view('a', false).opsPerSec).toBe(0); // counters reset each tick
  });

  it('uses real elapsed time, not an assumed 1 s, when a tick is late', () => {
    const { m } = make();
    for (let i = 0; i < 100; i++) m.countOp('a');
    m.tick(2000);
    expect(m.view('a', false).opsPerSec).toBe(50);
  });

  it('computes p95 over a sliding window and forgets old samples', () => {
    const { m, advance } = make();
    for (let i = 1; i <= 100; i++) m.recordAck(i);
    m.tick();
    expect(m.view('a', false).ackP95Ms).toBe(96);
    advance(6000);
    m.tick();
    expect(m.view('a', false).ackP95Ms).toBe(0);
  });
});
