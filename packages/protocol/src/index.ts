/** Binary WebSocket protocol (Doc 03 §5): one table drives both encoding and decoding. */
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

interface KindMap {
  uint: number;
  str: string;
  bytes: Uint8Array;
}
type Field = readonly [name: string, kind: keyof KindMap];

/** Message code and the fields that follow `docKey`, in wire order. */
const SPECS = {
  SUBSCRIBE: [0, [['flags', 'uint']]],
  SUBSCRIBED: [
    1,
    [
      ['headSeq', 'uint'],
      ['access', 'uint'],
    ],
  ],
  SYNC_STEP1: [2, [['stateVector', 'bytes']]],
  SYNC_STEP2: [
    3,
    [
      ['update', 'bytes'],
      ['seq', 'uint'],
    ],
  ],
  UPDATE: [
    4,
    [
      ['opId', 'str'],
      ['update', 'bytes'],
    ],
  ],
  UPDATE_BROADCAST: [
    5,
    [
      ['seq', 'uint'],
      ['originClientId', 'str'],
      ['update', 'bytes'],
    ],
  ],
  ACK: [
    6,
    [
      ['opId', 'str'],
      ['seq', 'uint'],
    ],
  ],
  AWARENESS: [7, [['update', 'bytes']]],
  UNSUBSCRIBE: [8, []],
  ERROR: [
    9,
    [
      ['code', 'str'],
      ['message', 'str'],
      ['retryAfterMs', 'uint'],
    ],
  ],
  PING: [10, [['timestampMs', 'uint']]],
  PONG: [11, [['timestampMs', 'uint']]],
  RESYNC_HINT: [12, [['headSeq', 'uint']]],
} as const satisfies Record<string, readonly [number, readonly Field[]]>;

type Specs = typeof SPECS;
type FieldsOf<F extends readonly Field[]> = { [K in F[number] as K[0]]: KindMap[K[1]] };

export type Message = {
  [N in keyof Specs]: { type: N; docKey: string } & FieldsOf<Specs[N][1]>;
}[keyof Specs];
export type MessageType = Message['type'];

/** Close codes (Doc 03 §5.5). */
export const CLOSE_CODES = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  TRY_AGAIN_LATER: 1013,
  UNAUTHENTICATED: 4001,
  FORBIDDEN: 4003,
  RATE_LIMITED: 4008,
  PAYLOAD_TOO_LARGE: 4009,
  TOKEN_EXPIRED: 4010,
  QUOTA_EXCEEDED: 4402,
  INTERNAL: 4500,
} as const;

const BY_CODE = new Map<number, MessageType>(
  (Object.entries(SPECS) as [MessageType, Specs[MessageType]][]).map(([name, [code]]) => [
    code,
    name,
  ]),
);

export function encodeMessage(msg: Message): Uint8Array {
  const [code, fields] = SPECS[msg.type] as readonly [number, readonly Field[]];
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, code);
  encoding.writeVarString(enc, msg.docKey);
  const values = msg as unknown as Record<string, unknown>;
  for (const [name, kind] of fields) {
    const v = values[name];
    if (kind === 'uint') encoding.writeVarUint(enc, v as number);
    else if (kind === 'str') encoding.writeVarString(enc, v as string);
    else encoding.writeVarUint8Array(enc, v as Uint8Array);
  }
  return encoding.toUint8Array(enc);
}

/** Decodes one frame. Throws only ProtocolError, whatever bytes it is given. */
export function decodeMessage(buf: Uint8Array): Message {
  try {
    const dec = decoding.createDecoder(buf);
    const type = BY_CODE.get(decoding.readVarUint(dec));
    if (type === undefined) throw new ProtocolError('unknown message type');
    const out: Record<string, unknown> = { type, docKey: decoding.readVarString(dec) };
    for (const [name, kind] of SPECS[type][1] as readonly Field[]) {
      out[name] =
        kind === 'uint'
          ? decoding.readVarUint(dec)
          : kind === 'str'
            ? decoding.readVarString(dec)
            : decoding.readVarUint8Array(dec);
    }
    if (decoding.hasContent(dec)) throw new ProtocolError('trailing bytes');
    return out as Message;
  } catch (e) {
    throw e instanceof ProtocolError ? e : new ProtocolError('malformed frame');
  }
}
