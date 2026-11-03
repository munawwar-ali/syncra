/** SSRF protection for webhook targets (Doc 02 §10): block loopback, private, link-local and similar ranges. */
import dns from 'node:dns';
import net from 'node:net';
import { SyncraError } from '@syncra/shared';

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((n, p) => (n << 8) + Number(p), 0) >>> 0;
}

const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, includes cloud metadata 169.254.169.254
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

/** True when connecting to this IP address could reach internal infrastructure. */
export function isBlockedAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const n = ipv4ToInt(ip);
    return V4_BLOCKED.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) >>> 0 === (ipv4ToInt(base) & mask) >>> 0;
    });
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1]) return isBlockedAddress(mapped[1]);
    if (lower === '::' || lower === '::1') return true;
    const first = parseInt(lower.split(':')[0] || '0', 16);
    return (
      (first & 0xfe00) === 0xfc00 || // unique local fc00::/7
      (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
      (first & 0xff00) === 0xff00 // multicast
    );
  }
  return true; // not an IP at all: refuse
}

export interface ResolvedTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

/** Validates scheme and resolves the host, refusing private targets unless `allowPrivate`. */
export async function resolveTarget(
  rawUrl: string,
  allowPrivate: boolean,
  lookup: typeof dns.promises.lookup = dns.promises.lookup,
): Promise<ResolvedTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SyncraError('VALIDATION_FAILED', 'Invalid webhook URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new SyncraError('VALIDATION_FAILED', 'Webhook URL must be http or https');
  }
  if (url.username || url.password)
    throw new SyncraError('VALIDATION_FAILED', 'Credentials in URL are not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host)
    ? [{ address: host, family: net.isIP(host) }]
    : await lookup(host, { all: true });
  if (addrs.length === 0)
    throw new SyncraError('VALIDATION_FAILED', 'Webhook host did not resolve');
  if (!allowPrivate && addrs.some((a) => isBlockedAddress(a.address))) {
    throw new SyncraError('VALIDATION_FAILED', 'Webhook target is not a public address');
  }
  const pick = addrs[0] as { address: string; family: number };
  return { url, address: pick.address, family: pick.family === 6 ? 6 : 4 };
}
