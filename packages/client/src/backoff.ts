/** Reconnect delay with full jitter (Doc 04 §5.1): random(0, min(cap, base * 2^attempt)). */

export const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 30_000;
/** The attempt counter resets after this long in `live`. */
export const BACKOFF_STABLE_MS = 30_000;

export function backoffDelay(
  attempt: number,
  random: () => number = Math.random,
  retryAfterMs = 0,
): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(attempt, 20));
  return Math.max(Math.floor(random() * ceiling), retryAfterMs);
}
