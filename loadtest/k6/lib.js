// Minimal Syncra wire protocol for load generators (Doc 03 section 5). Plain ES module with no imports, so
// the same file runs inside k6 (which has no npm) and in Node. Verified against real Yjs and the server's
// codec in loadtest/node/lib.test.ts.

export const MSG = {
  SUBSCRIBE: 0,
  SUBSCRIBED: 1,
  SYNC_STEP1: 2,
  SYNC_STEP2: 3,
  UPDATE: 4,
  UPDATE_BROADCAST: 5,
  ACK: 6,
  AWARENESS: 7,
  UNSUBSCRIBE: 8,
  ERROR: 9,
  PING: 10,
  PONG: 11,
  RESYNC_HINT: 12,
};

/** @param {number[]} out @param {number} n */
export function writeVarUint(out, n) {
  while (n > 127) {
    out.push(128 | (n & 127));
    n = Math.floor(n / 128);
  }
  out.push(n & 127);
}

/** @param {number[]} out @param {string} s */
export function writeVarString(out, s) {
  const bytes = utf8(s);
  writeVarUint(out, bytes.length);
  for (const b of bytes) out.push(b);
}

/** @param {number[]} out @param {ArrayLike<number>} bytes */
export function writeVarBytes(out, bytes) {
  writeVarUint(out, bytes.length);
  for (let i = 0; i < bytes.length; i++) out.push(bytes[i]);
}

/** UTF-8 without TextEncoder (k6 provides it, but this keeps the file dependency-free). @param {string} s */
export function utf8(s) {
  const out = [];
  for (const ch of s) {
    const c = /** @type {number} */ (ch.codePointAt(0));
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

/** Returns a frame ready to send as a binary WebSocket message. @param {number} type @param {string} docKey @param {(out: number[]) => void} [fields] */
export function frame(type, docKey, fields) {
  const out = [];
  writeVarUint(out, type);
  writeVarString(out, docKey);
  if (fields) fields(out);
  return new Uint8Array(out).buffer;
}

export const subscribeFrame = (docKey) => frame(MSG.SUBSCRIBE, docKey, (o) => writeVarUint(o, 0));
export const pingFrame = () => frame(MSG.PING, '', (o) => writeVarUint(o, Date.now()));
export const updateFrame = (docKey, opId, update) =>
  frame(MSG.UPDATE, docKey, (o) => {
    writeVarString(o, opId);
    writeVarBytes(o, update);
  });

/**
 * A valid Yjs v1 update that inserts `text` into the root Y.Text `root` as a client that has never
 * written before. `clock` is the number of characters this client already inserted (Yjs counts clock in
 * characters), so successive calls with the right clock form a gapless history.
 * Items carry no origin, so concurrent writers interleave arbitrarily, which is fine for load.
 */
export function textInsertUpdate(clientId, clock, text, root = 't') {
  const out = [];
  writeVarUint(out, 1); // one client with structs
  writeVarUint(out, 1); // one struct
  writeVarUint(out, clientId);
  writeVarUint(out, clock);
  out.push(4); // info: content ref 4 = ContentString, no origin/right-origin/parentSub
  writeVarUint(out, 1); // parent is a root type, identified by key
  writeVarString(out, root);
  writeVarString(out, text);
  writeVarUint(out, 0); // empty delete set
  return new Uint8Array(out);
}

/** Number of Yjs clock ticks `text` consumes: one per UTF-16 code unit. */
export const clockLength = (text) => text.length;

/** Reads the frame header. Returns the type, document key and the offset where the fields start. @param {Uint8Array} buf */
export function readHeader(buf) {
  let pos = 0;
  const varUint = () => {
    let n = 0;
    let mul = 1;
    for (;;) {
      const b = buf[pos++];
      n += (b & 127) * mul;
      if (b < 128) return n;
      mul *= 128;
    }
  };
  const type = varUint();
  const len = varUint();
  let docKey = '';
  for (let i = 0; i < len; i++) docKey += String.fromCharCode(buf[pos + i]);
  pos += len;
  return { type, docKey, offset: pos };
}

/** Finds an ASCII marker like T1766752800123 inside raw update bytes without decoding Yjs. @param {Uint8Array} bytes */
export function findTimestamp(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  const m = /T(\d{13})/.exec(s);
  return m ? Number(m[1]) : null;
}

/** Percentile of a numeric array (nearest rank). @param {number[]} values @param {number} p between 0 and 1 */
export function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}
