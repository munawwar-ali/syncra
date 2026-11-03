import { describe, expect, it } from 'vitest';
import { isBlockedAddress, resolveTarget } from './ssrf.js';
import { signPayload, verifySignature } from './sign.js';

describe('SSRF guard', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '0.0.0.0',
    '100.64.0.1',
    '::1',
    '::',
    'fe80::1',
    'fd12:3456::1',
    '::ffff:10.0.0.1',
    'not-an-ip',
  ])('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });
  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    'allows %s',
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    },
  );
  it('rejects a hostname that resolves to a private address (DNS pointing inward)', async () => {
    const lookup = (() => Promise.resolve([{ address: '10.0.0.5', family: 4 }])) as never;
    await expect(resolveTarget('https://evil.example/hook', false, lookup)).rejects.toThrow(
      /public/,
    );
    await expect(resolveTarget('https://evil.example/hook', true, lookup)).resolves.toMatchObject({
      address: '10.0.0.5',
    });
  });
  it('rejects non-http schemes, embedded credentials and literal private IPs', async () => {
    await expect(resolveTarget('file:///etc/passwd', false)).rejects.toThrow();
    await expect(resolveTarget('ftp://example.com', false)).rejects.toThrow();
    await expect(resolveTarget('https://user:pw@example.com', false)).rejects.toThrow();
    await expect(resolveTarget('http://127.0.0.1:8080/x', false)).rejects.toThrow();
    await expect(resolveTarget('http://[::1]/x', false)).rejects.toThrow();
    await expect(resolveTarget('nonsense', false)).rejects.toThrow();
  });
});

describe('webhook signatures', () => {
  const body = '{"id":"evt_1"}';
  it('verifies a fresh signature and rejects tampering, wrong secret and stale timestamps', () => {
    const now = 1_766_752_800;
    const header = signPayload('whsec_abc', body, now);
    expect(header).toMatch(/^t=1766752800,v1=[0-9a-f]{64}$/);
    expect(verifySignature(header, 'whsec_abc', body, now + 10)).toBe(true);
    expect(verifySignature(header, 'whsec_abc', body + ' ', now)).toBe(false);
    expect(verifySignature(header, 'whsec_other', body, now)).toBe(false);
    expect(verifySignature(header, 'whsec_abc', body, now + 301)).toBe(false);
    expect(verifySignature('garbage', 'whsec_abc', body, now)).toBe(false);
  });
});
