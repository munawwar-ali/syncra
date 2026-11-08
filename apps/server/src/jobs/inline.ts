/** The worker's scheduled jobs on timers inside the node, for single-process deployments (INLINE_JOBS=true). */
import type { Config } from '../config.js';
import type { Deps } from '../health.js';
import { WebhookDispatcher } from '../webhooks/dispatcher.js';
import { flushUsage, refreshGauges } from './usage.js';
import { maintainShard } from './lifecycle.js';

export function startInlineJobs(cfg: Config, deps: Deps): () => void {
  const dispatcher = new WebhookDispatcher(deps.control, {
    encryptionKey: Buffer.from(cfg.ENCRYPTION_KEY, 'base64'),
    allowPrivate: cfg.WEBHOOK_ALLOW_PRIVATE,
  });
  const quiet = (): undefined => undefined;
  const timers = [
    setInterval(() => void dispatcher.runDue().catch(quiet), 5_000),
    setInterval(() => {
      void flushUsage(deps.redis, deps.control).catch(quiet);
      void refreshGauges(deps.shards, deps.control).catch(quiet);
    }, 15_000),
    setInterval(() => {
      for (const shard of deps.shards) {
        void maintainShard(shard, deps.redis, {
          everyOps: cfg.SNAPSHOT_EVERY_OPS,
          everyBytes: cfg.SNAPSHOT_EVERY_BYTES,
          idleMs: cfg.SNAPSHOT_IDLE_MS,
          checkpointMs: cfg.CHECKPOINT_INTERVAL_MS,
          retentionDays: () => Promise.resolve(30),
        }).catch(quiet);
      }
    }, 30_000),
  ];
  // shortcut: no distributed lock, so run this on one node only; use the worker app when scaling out.
  return () => {
    timers.forEach(clearInterval);
  };
}
