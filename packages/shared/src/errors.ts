/** Error codes and the SyncraError class used for every deliberately thrown error (Doc 03 §6). */

export const ERROR_CODES = {
  UNAUTHENTICATED: { httpStatus: 401, retryable: true },
  FORBIDDEN: { httpStatus: 403, retryable: false },
  NOT_FOUND: { httpStatus: 404, retryable: false },
  CONFLICT: { httpStatus: 409, retryable: false },
  VALIDATION_FAILED: { httpStatus: 422, retryable: false },
  PAYLOAD_TOO_LARGE: { httpStatus: 413, retryable: false },
  RATE_LIMITED: { httpStatus: 429, retryable: true },
  QUOTA_EXCEEDED: { httpStatus: 402, retryable: true },
  UNAVAILABLE: { httpStatus: 503, retryable: true },
  INTERNAL: { httpStatus: 500, retryable: true },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export class SyncraError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'SyncraError';
    this.code = code;
    this.httpStatus = ERROR_CODES[code].httpStatus;
    this.retryable = ERROR_CODES[code].retryable;
    this.details = details;
  }

  /** Wraps any thrown value; unknown errors become INTERNAL without leaking their message. */
  static from(err: unknown): SyncraError {
    return err instanceof SyncraError ? err : new SyncraError('INTERNAL', 'Internal error');
  }

  /** REST error body (Doc 03 §6). */
  toBody(requestId: string): { error: Record<string, unknown> } {
    return {
      error: { code: this.code, message: this.message, details: this.details, requestId },
    };
  }
}
