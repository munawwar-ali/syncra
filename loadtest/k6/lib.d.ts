export const MSG: {
  readonly SUBSCRIBE: number;
  readonly SUBSCRIBED: number;
  readonly SYNC_STEP1: number;
  readonly SYNC_STEP2: number;
  readonly UPDATE: number;
  readonly UPDATE_BROADCAST: number;
  readonly ACK: number;
  readonly AWARENESS: number;
  readonly UNSUBSCRIBE: number;
  readonly ERROR: number;
  readonly PING: number;
  readonly PONG: number;
  readonly RESYNC_HINT: number;
};
export function writeVarUint(out: number[], n: number): void;
export function writeVarString(out: number[], s: string): void;
export function writeVarBytes(out: number[], bytes: ArrayLike<number>): void;
export function utf8(s: string): number[];
export function frame(type: number, docKey: string, fields?: (out: number[]) => void): ArrayBuffer;
export function subscribeFrame(docKey: string): ArrayBuffer;
export function pingFrame(): ArrayBuffer;
export function updateFrame(docKey: string, opId: string, update: Uint8Array): ArrayBuffer;
export function textInsertUpdate(
  clientId: number,
  clock: number,
  text: string,
  root?: string,
): Uint8Array;
export function clockLength(text: string): number;
export function readHeader(buf: Uint8Array): { type: number; docKey: string; offset: number };
export function findTimestamp(bytes: Uint8Array): number | null;
export function percentile(values: number[], p: number): number;
