/** Connection state machine (Doc 04 §5): a pure transition function, one row per table entry. */
import type { ConnectionState } from './types.js';

export type MachineEvent =
  | { type: 'CONNECT'; online: boolean }
  | { type: 'DISCONNECT' }
  | { type: 'OFFLINE' }
  | { type: 'ONLINE' }
  | { type: 'SOCKET_OPEN' }
  | { type: 'SOCKET_CLOSE'; code?: number }
  | { type: 'SUBSCRIBED' }
  | { type: 'ALL_SYNCED' }
  | { type: 'PING_TIMEOUT' }
  | { type: 'QUOTA' }
  | { type: 'TIMER' }
  | { type: 'TOKEN_REFRESHED' }
  | { type: 'TOKEN_FAILED' }
  | { type: 'FATAL' };

const ACTIVE: ConnectionState[] = ['connecting', 'authenticating', 'syncing', 'live'];

/** Returns the next state; events that do not apply leave the state unchanged. */
export function transition(state: ConnectionState, ev: MachineEvent): ConnectionState {
  switch (ev.type) {
    case 'DISCONNECT':
      return 'idle';
    case 'FATAL':
      return state === 'idle' ? state : 'error';
    case 'OFFLINE':
      return state === 'idle' ? state : 'offline';
    case 'CONNECT':
      return state === 'idle' || state === 'error' ? (ev.online ? 'connecting' : 'offline') : state;
    case 'ONLINE':
      return state === 'offline' ? 'connecting' : state;
    case 'SOCKET_OPEN':
      return state === 'connecting' ? 'authenticating' : state;
    case 'SUBSCRIBED':
      return state === 'authenticating' ? 'syncing' : state;
    case 'ALL_SYNCED':
      return state === 'syncing' ? 'live' : state;
    case 'SOCKET_CLOSE':
      if (!ACTIVE.includes(state)) return state;
      if (ev.code === 4001 || ev.code === 4010) return 'authenticating';
      if (ev.code === 4003) return 'error';
      if (ev.code === 4402) return 'quota-blocked';
      return 'backoff';
    case 'PING_TIMEOUT':
      return ACTIVE.includes(state) ? 'backoff' : state;
    case 'QUOTA':
      return state === 'live' || state === 'syncing' ? 'quota-blocked' : state;
    case 'TIMER':
      return state === 'backoff' || state === 'quota-blocked' ? 'connecting' : state;
    case 'TOKEN_REFRESHED':
      return state === 'authenticating' || state === 'auth-expired' ? 'connecting' : state;
    case 'TOKEN_FAILED':
      return state === 'authenticating' ? 'auth-expired' : state;
  }
}
