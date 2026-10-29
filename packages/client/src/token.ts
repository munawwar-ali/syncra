/** Token lifecycle (CLI-08): cache the JWT, refresh at 80% of its lifetime and on demand. */

export interface TokenClaims {
  tid?: string;
  sub?: string;
  exp?: number;
  iat?: number;
}

/** Decodes a JWT payload without verifying it (the server verifies; we only read exp/tid/sub). */
export function decodeClaims(token: string): TokenClaims {
  const part = token.split('.')[1];
  if (!part) return {};
  try {
    const b64 = part
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(part.length / 4) * 4, '=');
    return JSON.parse(atob(b64)) as TokenClaims;
  } catch {
    return {};
  }
}

export class TokenManager {
  private token: string | null = null;
  private refreshAtMs = 0;
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly getToken: () => Promise<string>,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns a usable token, fetching a new one when none is cached or 80% of its life is spent. */
  get(): Promise<string> {
    if (this.token && this.now() < this.refreshAtMs) return Promise.resolve(this.token);
    return (this.inflight ??= this.fetch().finally(() => {
      this.inflight = null;
    }));
  }

  /** Drops the cached token (after a 4001/4010 close) so the next get() asks the app again. */
  invalidate(): void {
    this.token = null;
  }

  claims(): TokenClaims {
    return this.token ? decodeClaims(this.token) : {};
  }

  private async fetch(): Promise<string> {
    const t = await this.getToken();
    const { exp, iat } = decodeClaims(t);
    const start = iat ? iat * 1000 : this.now();
    this.refreshAtMs = exp ? start + (exp * 1000 - start) * 0.8 : this.now() + 60_000;
    this.token = t;
    return t;
  }
}
