/**
 * Worker entry point: runs the scheduled jobs (usage flush, gauge refresh, webhook delivery) and
 * serves /healthz and /metrics on WORKER_PORT. See ADR 0020 for why this is a timer loop with Redis
 * locks and not BullMQ yet.
 */
import http from 'node:http';
import { Redis } from 'ioredis';
import pg from 'pg';
import { pino } from 'pino';
import { Counter, Registry, collectDefaultMetrics } from 'prom-client';
import { WebhookDispatcher, flushUsage, loadConfig, refreshGauges } from '@syncra/server/jobs';

const cfg = loadConfig();
const log = pino({ level: cfg.LOG_LEVEL, base: { nodeId: cfg.NODE_ID, role: 'worker' } });
const control = new pg.Pool({ connectionString: cfg.CONTROL_DATABASE_URL, max: 5 });
const shards = cfg.SHARD_DATABASE_URLS.map((u) => new pg.Pool({ connectionString: u, max: 5 }));
const redis = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: 2 });
redis.on('error', () => undefined);

const registry = new Registry();
collectDefaultMetrics({ register: registry });
const runs = new Counter({
  name: 'syncra_job_runs_total',
  help: 'Job runs',
  labelNames: ['job', 'status'] as const,
  registers: [registry],
});

const dispatcher = new WebhookDispatcher(control, {
  encryptionKey: Buffer.from(cfg.ENCRYPTION_KEY, 'base64'),
  allowPrivate: cfg.WEBHOOK_ALLOW_PRIVATE,
});

/** Runs `fn` every `everyMs`, but only on the worker that wins the Redis lock, so replicas never double-run. */
function schedule(name: string, everyMs: number, fn: () => Promise<unknown>): NodeJS.Timeout {
  const tick = async (): Promise<void> => {
    try {
      const got = await redis.set(
        `sx:lock:job:${name}`,
        cfg.NODE_ID,
        'PX',
        Math.max(1000, everyMs - 500),
        'NX',
      );
      if (got !== 'OK') return;
      await fn();
      runs.labels(name, 'ok').inc();
    } catch (err) {
      runs.labels(name, 'error').inc();
      log.error({ err, job: name }, 'job failed');
    }
  };
  void tick();
  return setInterval(() => void tick(), everyMs);
}

const timers = [
  schedule('webhook:deliver', 2_000, () => dispatcher.runDue()),
  schedule('usage:flush', 10 * 60_000, () => flushUsage(redis, control)),
  schedule('usage:gauges', 60_000, () => refreshGauges(shards, control)),
];

const health = http.createServer((req, res) => {
  if (req.url === '/metrics') {
    void registry.metrics().then((m) => {
      res.setHeader('content-type', registry.contentType);
      res.end(m);
    });
  } else if (req.url === '/healthz') {
    res.end('{"status":"ok"}');
  } else {
    res.statusCode = 404;
    res.end();
  }
});
health.listen(Number(process.env.WORKER_PORT ?? 9100), '0.0.0.0');
log.info('worker started');

const shutdown = async (): Promise<void> => {
  timers.forEach(clearInterval);
  health.close();
  await flushUsage(redis, control).catch(() => undefined); // do not leave counters behind on a clean stop
  await Promise.all([control.end(), ...shards.map((s) => s.end()), redis.quit()]);
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
