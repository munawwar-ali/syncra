import { describe, expect, it } from 'vitest';
import { resolveAccess, type AccessRule } from './access.js';

const rules: AccessRule[] = [
  { collection: 'inspections', docs: '*', mode: 'rw' },
  { collection: 'templates', docs: ['tpl_1'], mode: 'r' },
];

describe('resolveAccess', () => {
  it('grants by collection and doc list', () => {
    expect(resolveAccess(rules, 'inspections', 'any')).toBe('rw');
    expect(resolveAccess(rules, 'templates', 'tpl_1')).toBe('r');
  });
  it('denies other docs and collections', () => {
    expect(resolveAccess(rules, 'templates', 'tpl_2')).toBeNull();
    expect(resolveAccess(rules, 'secrets', 'x')).toBeNull();
  });
  it('rw wins over r when both match', () => {
    const both: AccessRule[] = [
      { collection: 'a', docs: '*', mode: 'r' },
      { collection: 'a', docs: ['x'], mode: 'rw' },
    ];
    expect(resolveAccess(both, 'a', 'x')).toBe('rw');
    expect(resolveAccess(both, 'a', 'y')).toBe('r');
  });
});
