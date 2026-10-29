import { describe, expect, it } from 'vitest';
import { transition, type MachineEvent } from './machine.js';
import type { ConnectionState as S } from './types.js';

type Row = [S, MachineEvent, S];
// One row per entry in the Doc 04 §5 transition table, plus the guard cases.
const ROWS: Row[] = [
  ['idle', { type: 'CONNECT', online: true }, 'connecting'],
  ['idle', { type: 'CONNECT', online: false }, 'offline'],
  ['error', { type: 'CONNECT', online: true }, 'connecting'],
  ['connecting', { type: 'OFFLINE' }, 'offline'],
  ['live', { type: 'OFFLINE' }, 'offline'],
  ['backoff', { type: 'OFFLINE' }, 'offline'],
  ['idle', { type: 'OFFLINE' }, 'idle'],
  ['offline', { type: 'ONLINE' }, 'connecting'],
  ['live', { type: 'ONLINE' }, 'live'],
  ['connecting', { type: 'SOCKET_OPEN' }, 'authenticating'],
  ['connecting', { type: 'SOCKET_CLOSE' }, 'backoff'],
  ['authenticating', { type: 'SUBSCRIBED' }, 'syncing'],
  ['syncing', { type: 'ALL_SYNCED' }, 'live'],
  ['live', { type: 'SOCKET_CLOSE', code: 1006 }, 'backoff'],
  ['live', { type: 'SOCKET_CLOSE', code: 1001 }, 'backoff'],
  ['live', { type: 'PING_TIMEOUT' }, 'backoff'],
  ['live', { type: 'QUOTA' }, 'quota-blocked'],
  ['backoff', { type: 'TIMER' }, 'connecting'],
  ['live', { type: 'SOCKET_CLOSE', code: 4001 }, 'authenticating'],
  ['live', { type: 'SOCKET_CLOSE', code: 4010 }, 'authenticating'],
  ['authenticating', { type: 'TOKEN_REFRESHED' }, 'connecting'],
  ['authenticating', { type: 'TOKEN_FAILED' }, 'auth-expired'],
  ['auth-expired', { type: 'TOKEN_REFRESHED' }, 'connecting'],
  ['live', { type: 'SOCKET_CLOSE', code: 4402 }, 'quota-blocked'],
  ['quota-blocked', { type: 'TIMER' }, 'connecting'],
  ['live', { type: 'SOCKET_CLOSE', code: 4003 }, 'error'],
  ['syncing', { type: 'FATAL' }, 'error'],
  ['live', { type: 'DISCONNECT' }, 'idle'],
  ['offline', { type: 'DISCONNECT' }, 'idle'],
  ['quota-blocked', { type: 'DISCONNECT' }, 'idle'],
  ['backoff', { type: 'SOCKET_CLOSE' }, 'backoff'],
];

describe('connection state machine (CLI-03)', () => {
  it.each(ROWS)('%s + %j -> %s', (from, ev, to) => {
    expect(transition(from, ev)).toBe(to);
  });
});
