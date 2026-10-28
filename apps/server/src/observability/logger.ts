/** pino logger factory. Redacts secrets; the `token` query param is stripped from logged URLs. */
import { pino, type Logger } from 'pino';

export function createLogger(level: string, nodeId: string): Logger {
  return pino({
    level,
    base: { nodeId },
    redact: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token'],
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

/** Removes `token=...` from a URL so it is safe to log. */
export function redactUrl(url: string): string {
  return url.replace(/([?&])token=[^&]*/g, '$1token=[redacted]');
}
