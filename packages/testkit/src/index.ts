export * from './fake-server.js';
export * from './network.js';

/** Builds a JWT-shaped token (unsigned) with the given claims; the fake server only checks presence. */
export function fakeToken(
  claims: { tid?: string; sub?: string; ttlSeconds?: number } = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    tid: claims.tid ?? 'tenant-1',
    sub: claims.sub ?? 'user-1',
    iat: now,
    exp: now + (claims.ttlSeconds ?? 3600),
  };
  const b64 = btoa(JSON.stringify(payload))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `eyJhbGciOiJIUzI1NiJ9.${b64}.sig`;
}
