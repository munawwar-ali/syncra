import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { restoreRoots } from './doc-service.js';

/** Builds the update that turns `current` into `target`, the way DocService.restore does. */
function restoreUpdate(current: Y.Doc, target: Y.Doc): Y.Doc {
  const work = new Y.Doc();
  Y.applyUpdate(work, Y.encodeStateAsUpdate(current));
  const before = Y.encodeStateVector(work);
  work.transact(() => {
    restoreRoots(work, target);
  });
  const result = new Y.Doc();
  Y.applyUpdate(result, Y.encodeStateAsUpdate(current));
  Y.applyUpdate(result, Y.encodeStateAsUpdate(work, before));
  return result;
}

describe('restoreRoots (DAT-05)', () => {
  it('restores map keys: deletes extras, resets changed, re-adds removed', () => {
    const target = new Y.Doc();
    target.getMap('data').set('a', 1);
    target.getMap('data').set('b', { nested: true });
    const current = new Y.Doc();
    Y.applyUpdate(current, Y.encodeStateAsUpdate(target));
    current.getMap('data').set('a', 99);
    current.getMap('data').delete('b');
    current.getMap('data').set('extra', 'x');
    expect(restoreUpdate(current, target).getMap('data').toJSON()).toEqual({
      a: 1,
      b: { nested: true },
    });
  });

  it('restores text with its formatting, arrays, and rich-text fragments', () => {
    const target = new Y.Doc();
    target.getText('text').insert(0, 'hello ');
    target.getText('text').insert(6, 'world', { bold: true });
    target.getArray('list').push([1, 'two', { three: 3 }]);
    const p = new Y.XmlElement('p');
    p.insert(0, [new Y.XmlText('original paragraph')]);
    target.getXmlFragment('content').insert(0, [p]);

    const current = new Y.Doc();
    Y.applyUpdate(current, Y.encodeStateAsUpdate(target));
    current.getText('text').delete(0, 5);
    current.getText('text').insert(0, 'changed');
    current.getArray('list').delete(0, 2);
    current.getXmlFragment('content').delete(0, 1);
    current.getXmlFragment('content').insert(0, [new Y.XmlElement('h1')]);

    const restored = restoreUpdate(current, target);
    expect(restored.getText('text').toDelta()).toEqual(target.getText('text').toDelta());
    expect(restored.getArray('list').toJSON()).toEqual([1, 'two', { three: 3 }]);
    expect(restored.getXmlFragment('content').toJSON()).toBe(
      target.getXmlFragment('content').toJSON(),
    );
  });

  it('is non-destructive: the restore is a new update on top of existing history', () => {
    const target = new Y.Doc();
    target.getMap('data').set('v', 1);
    const current = new Y.Doc();
    Y.applyUpdate(current, Y.encodeStateAsUpdate(target));
    current.getMap('data').set('v', 2);
    const work = new Y.Doc();
    Y.applyUpdate(work, Y.encodeStateAsUpdate(current));
    const before = Y.encodeStateVector(work);
    work.transact(() => {
      restoreRoots(work, target);
    });
    const delta = Y.encodeStateAsUpdate(work, before);
    // A client that has not seen the restore still converges once it receives the delta.
    const lagging = new Y.Doc();
    Y.applyUpdate(lagging, Y.encodeStateAsUpdate(current));
    Y.applyUpdate(lagging, delta);
    expect(lagging.getMap('data').get('v')).toBe(1);
  });
});
