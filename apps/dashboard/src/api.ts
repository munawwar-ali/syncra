/**
 * API client: the access token lives in memory only; the httpOnly refresh cookie renews it. A 401
 * triggers exactly one shared refresh and one retry, so parallel requests never refresh twice.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let accessToken: string | null = null;
let tenantId: string | null = null;
let refreshing: Promise<boolean> | null = null;
let onSessionLost: () => void = () => undefined;

export const setAccessToken = (t: string | null): void => {
  accessToken = t;
};
export const setTenant = (id: string | null): void => {
  tenantId = id;
};
export const onSessionExpired = (cb: () => void): void => {
  onSessionLost = cb;
};

/** Renews the access token from the refresh cookie. Resolves false when there is no valid session. */
export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const res = await fetch('/v1/auth/refresh', { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) return false;
      accessToken = ((await res.json()) as { accessToken: string }).accessToken;
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => {
        refreshing = null;
      }, 0);
    }
  })();
  return refreshing;
}

function headers(extra?: HeadersInit): Headers {
  const h = new Headers(extra);
  if (accessToken) h.set('authorization', `Bearer ${accessToken}`);
  if (tenantId) h.set('x-tenant-id', tenantId);
  return h;
}

async function toError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as {
      error?: { code?: string; message?: string; details?: Record<string, unknown> };
    };
    return new ApiError(
      res.status,
      body.error?.code ?? 'ERROR',
      body.error?.message ?? res.statusText,
      body.error?.details,
    );
  } catch {
    return new ApiError(res.status, 'ERROR', res.statusText || 'Request failed');
  }
}

/** Raw authenticated fetch with the refresh-and-retry behaviour. */
export async function request(method: string, path: string, body?: unknown): Promise<Response> {
  const send = (): Promise<Response> =>
    fetch(`/v1${path}`, {
      method,
      credentials: 'same-origin',
      headers: headers(body === undefined ? undefined : { 'content-type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  let res = await send();
  if (res.status === 401 && (await refreshSession())) res = await send();
  if (res.status === 401) onSessionLost();
  if (!res.ok) throw await toError(res);
  return res;
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await request(method, path, body);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/** Public endpoints (login, signup): no bearer token, but the response sets the refresh cookie. */
export async function publicPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/v1${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

/** Streams a Server-Sent Events endpoint with the auth header (EventSource cannot send one). */
export async function streamEvents(
  path: string,
  onEvent: (event: string, data: unknown) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await request('GET', path);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  let buf = '';
  signal.addEventListener('abort', () => void reader.cancel().catch(() => undefined));
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (data) onEvent(event, JSON.parse(data));
    }
  }
}

/** Fetches a binary or HTML resource with auth and returns an object URL (for invoice view/PDF). */
export async function fetchBlobUrl(path: string): Promise<string> {
  const res = await request('GET', path);
  return URL.createObjectURL(await res.blob());
}
