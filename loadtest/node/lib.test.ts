import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { decodeMessage } from '@syncra/protocol';
import {
  MSG,
  clockLength,
  findTimestamp,
  percentile,
  pingFrame,
  readHeader,
  subscribeFrame,
  textInsertUpdate,
  updateFrame,
  utf8,
} from '../k6/lib.js';

describe('load generator protocol helpers', () => {
  it('builds frames the real server codec decodes', () => {
    const sub = decodeMessage(new Uint8Array(subscribeFrame('notes/doc-1')));
    expect(sub).toMatchObject({ type: 'SUBSCRIBE', docKey: 'notes/doc-1', flags: 0 });
    const upd = decodeMessage(
      new Uint8Array(updateFrame('notes/doc-1', 'op-7', new Uint8Array([1, 2, 3]))),
    );
    expect(upd).toMatchObject({ type: 'UPDATE', docKey: 'notes/doc-1', opId: 'op-7' });
    expect(decodeMessage(new Uint8Array(pingFrame()))).toMatchObject({ type: 'PING', docKey: '' });
  });

  it('readHeader agrees with the server codec on type and key', () => {
    const h = readHeader(new Uint8Array(updateFrame('collection/id', 'x', new Uint8Array(0))));
    expect(h).toMatchObject({ type: MSG.UPDATE, docKey: 'collection/id' });
  });

  it('encodes UTF-8 like TextEncoder', () => {
    for (const s of ['plain', 'héllo', '日本語', 'emoji 🚀 ok']) {
      expect(utf8(s)).toEqual([...new TextEncoder().encode(s)]);
    }
  });

  it('textInsertUpdate produces updates real Yjs accepts, in order, across many writes and large client ids', () => {
    const doc = new Y.Doc();
    const clientId = 3_999_999_999; // larger than 2^31: exercises multi-byte varints
    let clock = 0;
    let expected = '';
    for (let i = 0; i < 50; i++) {
      const text = `op${String(i)}-`;
      Y.applyUpdate(doc, textInsertUpdate(clientId, clock, text));
      clock += clockLength(text);
      expected += text;
    }
    const got = doc.getText('t').toJSON();
    expect(got.length).toBe(expected.length);
    expect([...got].sort().join('')).toBe([...expected].sort().join('')); // same characters (order depends on conflict resolution)
    expect(Y.encodeStateVector(doc).length).toBeGreaterThan(0);
    expect(Y.decodeStateVector(Y.encodeStateVector(doc)).get(clientId)).toBe(expected.length); // gapless clock
  });

  it('two independent generated writers merge without pending structs', () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, textInsertUpdate(11, 0, 'aaaa'));
    Y.applyUpdate(doc, textInsertUpdate(22, 0, 'bbbb'));
    Y.applyUpdate(doc, textInsertUpdate(11, 4, 'cc'));
    expect(doc.getText('t').length).toBe(10);
    expect(doc.store.pendingStructs).toBeNull();
  });

  it('findTimestamp reads the marker straight out of update bytes, and nothing when absent', () => {
    const u = textInsertUpdate(5, 0, 'T1766752800123|pad');
    expect(findTimestamp(u)).toBe(1_766_752_800_123);
    expect(findTimestamp(textInsertUpdate(5, 0, 'no marker'))).toBeNull();
  });

  it('percentile uses nearest rank and tolerates empty input', () => {
    expect(percentile([], 0.95)).toBe(0);
    expect(percentile([5], 0.99)).toBe(5);
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(v, 0.5)).toBe(51);
    expect(percentile(v, 0.95)).toBe(96);
  });
});
