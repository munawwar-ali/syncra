/**
 * Cross-node fan-out transport (Doc 02 §4.5, Doc 03 §3). Redis pub/sub is fire-and-forget, so the
 * document service treats it as a hint and repairs gaps from Postgres; this file only moves bytes.
 */
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import type { Redis } from 'ioredis';

export interface PubSub {
  publish(channel: string, payload: Uint8Array): Promise<void>;
  subscribe(channel: string): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
  onMessage(cb: (channel: string, payload: Uint8Array) => void): void;
  /** False while the transport is known to be down; drives the degraded reconcile interval. */
  healthy(): boolean;
  close(): Promise<void>;
}

export const docChannel = (tenantId: string, docKey: string): string =>
  `sx:doc:${tenantId}:${docKey}:ch`;
export const awarenessChannel = (tenantId: string, docKey: string): string =>
  `sx:aw:${tenantId}:${docKey}:ch`;

export class RedisPubSub implements PubSub {
  private readonly sub: Redis;
  private ok = true;

  constructor(
    private readonly pub: Redis,
    onError: (e: unknown) => void = () => undefined,
  ) {
    this.sub = pub.duplicate();
    this.sub.on('error', (e: unknown) => {
      this.ok = false;
      onError(e);
    });
    this.sub.on('ready', () => {
      this.ok = true; // ioredis re-subscribes to existing channels by itself
    });
    this.sub.on('end', () => {
      this.ok = false;
    });
  }

  async publish(channel: string, payload: Uint8Array): Promise<void> {
    try {
      await this.pub.publish(channel, Buffer.from(payload));
    } catch (e) {
      this.ok = false;
      throw e;
    }
  }

  async subscribe(channel: string): Promise<void> {
    await this.sub.subscribe(channel);
  }

  async unsubscribe(channel: string): Promise<void> {
    await this.sub.unsubscribe(channel);
  }

  onMessage(cb: (channel: string, payload: Uint8Array) => void): void {
    this.sub.on('messageBuffer', (channel: Buffer, message: Buffer) => {
      cb(
        channel.toString(),
        new Uint8Array(message.buffer, message.byteOffset, message.byteLength),
      );
    });
  }

  healthy(): boolean {
    return this.ok;
  }

  close(): Promise<void> {
    this.sub.disconnect();
    return Promise.resolve();
  }
}

export interface DocBroadcast {
  seq: number;
  originNode: string;
  originClient: string;
  update: Uint8Array;
}

/** `varUint seq, varString originNode, varString originClient, varUint8Array update` (Doc 03 §3). */
export function encodeDocBroadcast(m: DocBroadcast): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, m.seq);
  encoding.writeVarString(e, m.originNode);
  encoding.writeVarString(e, m.originClient);
  encoding.writeVarUint8Array(e, m.update);
  return encoding.toUint8Array(e);
}

export function decodeDocBroadcast(buf: Uint8Array): DocBroadcast | null {
  try {
    const d = decoding.createDecoder(buf);
    return {
      seq: decoding.readVarUint(d),
      originNode: decoding.readVarString(d),
      originClient: decoding.readVarString(d),
      update: decoding.readVarUint8Array(d),
    };
  } catch {
    return null; // a malformed message from the bus is dropped; reconciliation repairs any gap
  }
}

export interface AwarenessBroadcast {
  originNode: string;
  update: Uint8Array;
}

export function encodeAwarenessBroadcast(m: AwarenessBroadcast): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarString(e, m.originNode);
  encoding.writeVarUint8Array(e, m.update);
  return encoding.toUint8Array(e);
}

export function decodeAwarenessBroadcast(buf: Uint8Array): AwarenessBroadcast | null {
  try {
    const d = decoding.createDecoder(buf);
    return { originNode: decoding.readVarString(d), update: decoding.readVarUint8Array(d) };
  } catch {
    return null;
  }
}
