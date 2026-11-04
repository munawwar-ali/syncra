import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { CLOSE_CODES, decodeMessage } from '@syncra/protocol';
import { Outbound, type BackpressureEvent, type SocketLike } from './outbound.js';

class FakeSocket implements SocketLike {
  bufferedAmount = 0;
  readyState = 1;
  sent: Uint8Array[] = [];
  closed: { code: number; reason: string } | null = null;
  send(d: Uint8Array): void {
    this.sent.push(d);
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
  }
}

function makeUpdates(n: number): Uint8Array[] {
  const d = new Y.Doc();
  const out: Uint8Array[] = [];
  d.on('update', (u: Uint8Array) => out.push(u));
  for (let i = 0; i < n; i++) d.getText('t').insert(i, 'x');
  return out;
}

function setup(over: { highWater?: number; slowCloseMs?: number } = {}) {
  const ws = new FakeSocket();
  const events: BackpressureEvent[] = [];
  let t = 0;
  const out = new Outbound(ws, {
    highWater: over.highWater ?? 1000,
    slowCloseMs: over.slowCloseMs ?? 15_000,
    now: () => t,
    onEvent: (e) => events.push(e),
  });
  return { ws, out, events, advance: (ms: number) => (t += ms) };
}

describe('Outbound backpressure (OPS-02)', () => {
  it('sends straight through while the buffer is below the high-water mark', () => {
    const { ws, out } = setup();
    const [u] = makeUpdates(1) as [Uint8Array];
    out.broadcast('n/a', 1, 'c1', u);
    expect(ws.sent).toHaveLength(1);
    expect(decodeMessage(ws.sent[0] as Uint8Array)).toMatchObject({
      type: 'UPDATE_BROADCAST',
      docKey: 'n/a',
      seq: 1,
    });
    out.dispose();
  });

  it('holds and merges updates per document while slow, so memory is bounded by documents not traffic', () => {
    const { ws, out, events } = setup();
    ws.bufferedAmount = 5000;
    const us = makeUpdates(500);
    us.forEach((u, i) => {
      out.broadcast(i % 2 ? 'n/a' : 'n/b', i + 1, 'c', u);
    });
    expect(ws.sent).toHaveLength(0);
    expect(out.isSlow).toBe(true);
    expect(out.pendingDocs).toBe(2);
    expect(events).toEqual(['slow']);
    out.dispose();
  });

  it('on drain, delivers one merged update per document that reproduces every change', () => {
    const { ws, out, events } = setup();
    const doc = new Y.Doc();
    const us: Uint8Array[] = [];
    doc.on('update', (u: Uint8Array) => us.push(u));
    for (let i = 0; i < 50; i++) doc.getText('t').insert(i, String(i % 10));
    ws.bufferedAmount = 5000;
    us.forEach((u, i) => {
      out.broadcast('n/a', i + 1, 'c', u);
    });
    ws.bufferedAmount = 100; // drained below half of high water
    out.check();
    expect(events).toEqual(['slow', 'resumed']);
    expect(ws.sent).toHaveLength(1);
    const msg = decodeMessage(ws.sent[0] as Uint8Array);
    if (msg.type !== 'UPDATE_BROADCAST') throw new Error('wrong frame');
    expect(msg.seq).toBe(50);
    const rebuilt = new Y.Doc();
    Y.applyUpdate(rebuilt, msg.update);
    expect(rebuilt.getText('t').toJSON()).toBe(doc.getText('t').toJSON());
    expect(out.isSlow).toBe(false);
  });

  it('closes a consumer that stays slow past the limit with 1013', () => {
    const { ws, out, events, advance } = setup({ slowCloseMs: 15_000 });
    ws.bufferedAmount = 5000;
    out.broadcast('n/a', 1, 'c', makeUpdates(1)[0] as Uint8Array);
    advance(14_000);
    out.check();
    expect(ws.closed).toBeNull();
    advance(1_500);
    out.check();
    expect(ws.closed?.code).toBe(CLOSE_CODES.TRY_AGAIN_LATER);
    expect(events).toEqual(['slow', 'closed']);
    expect(out.pendingDocs).toBe(0);
  });

  it('still sends control frames, but drops ephemeral frames, while slow', () => {
    const { ws, out } = setup();
    ws.bufferedAmount = 5000;
    out.broadcast('n/a', 1, 'c', makeUpdates(1)[0] as Uint8Array); // enters slow
    out.send(new Uint8Array([1]));
    out.sendEphemeral(new Uint8Array([2]));
    expect(ws.sent.map((f) => f[0])).toEqual([1]);
    out.dispose();
  });

  it('ignores a closed socket', () => {
    const { ws, out } = setup();
    ws.readyState = 3;
    out.broadcast('n/a', 1, 'c', makeUpdates(1)[0] as Uint8Array);
    expect(ws.sent).toHaveLength(0);
    expect(out.isSlow).toBe(false);
  });
});
