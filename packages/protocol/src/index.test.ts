import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodeMessage, encodeMessage, ProtocolError, type Message } from './index.js';

const b = (...n: number[]) => new Uint8Array(n);
const SAMPLES: Message[] = [
  { type: 'SUBSCRIBE', docKey: 'notes/a', flags: 1 },
  { type: 'SUBSCRIBED', docKey: 'notes/a', headSeq: 42, access: 1 },
  { type: 'SYNC_STEP1', docKey: 'notes/a', stateVector: b(1, 2, 3) },
  { type: 'SYNC_STEP2', docKey: 'notes/a', update: b(9, 9), seq: 7 },
  { type: 'UPDATE', docKey: 'notes/a', opId: 'sync:c:1', update: b(5) },
  { type: 'UPDATE_BROADCAST', docKey: 'notes/a', seq: 3, originClientId: 'c1', update: b(1) },
  { type: 'ACK', docKey: 'notes/a', opId: 'op1', seq: 100 },
  { type: 'AWARENESS', docKey: 'notes/a', update: b() },
  { type: 'UNSUBSCRIBE', docKey: 'notes/a' },
  { type: 'ERROR', docKey: '', code: 'RATE_LIMITED', message: 'slow down', retryAfterMs: 250 },
  { type: 'PING', docKey: '', timestampMs: 1_766_752_800_000 },
  { type: 'PONG', docKey: '', timestampMs: 1_766_752_800_000 },
  { type: 'RESYNC_HINT', docKey: 'notes/a', headSeq: 9 },
];

describe('protocol', () => {
  it.each(SAMPLES)('round-trips $type', (msg) => {
    expect(decodeMessage(encodeMessage(msg))).toEqual(msg);
  });

  it('rejects unknown types and trailing bytes', () => {
    expect(() => decodeMessage(b(99, 0))).toThrow(ProtocolError);
    const ok = encodeMessage(SAMPLES[8] as Message);
    expect(() => decodeMessage(new Uint8Array([...ok, 0]))).toThrow(/trailing/);
  });

  it('every truncation of every valid frame throws ProtocolError', () => {
    for (const msg of SAMPLES) {
      const frame = encodeMessage(msg);
      for (let n = 0; n < frame.length; n++) {
        expect(() => decodeMessage(frame.subarray(0, n))).toThrow(ProtocolError);
      }
    }
  });

  it('fuzz: random bytes never throw anything but ProtocolError', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
        try {
          decodeMessage(bytes);
        } catch (e) {
          expect(e).toBeInstanceOf(ProtocolError);
        }
      }),
      { numRuns: 5000 },
    );
  });

  it('fuzz: byte-flipped valid frames never crash the decoder', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SAMPLES),
        fc.nat(),
        fc.integer({ min: 0, max: 255 }),
        (msg, i, val) => {
          const frame = encodeMessage(msg);
          frame[i % frame.length] = val;
          try {
            decodeMessage(frame);
          } catch (e) {
            expect(e).toBeInstanceOf(ProtocolError);
          }
        },
      ),
      { numRuns: 2000 },
    );
  });
});
