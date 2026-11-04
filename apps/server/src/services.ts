/** Builds the long-lived services shared by HTTP routes and the WebSocket gateway. */
import type { Logger } from 'pino';
import { SyncraError } from '@syncra/shared';
import { createClientTokenVerifier, type TokenVerifier } from './auth/jwt.js';
import { parseEncryptionKey } from './auth/crypto.js';
import { Accounts } from './control/accounts.js';
import { ApiKeys } from './control/keys.js';
import { createTenantKeyProvider } from './control/signing.js';
import { Tenants } from './control/tenants.js';
import { DocService } from './core/doc-service.js';
import { Presence } from './core/presence.js';
import { RedisPubSub, type PubSub } from './core/pubsub.js';
import { gapRecoveries, opsReceived } from './observability/metrics.js';
import type { Config } from './config.js';
import type { Deps } from './health.js';
import { QuotaService } from './limits/quota.js';
import { InProcessLimiter, RedisLimiter, type Limiter } from './limits/token-bucket.js';
import { UsageCounters } from './limits/usage.js';
import { ShardRing } from './shards/ring.js';
import { Webhooks } from './webhooks/service.js';

export interface Services {
  cfg: Config;
  deps: Deps;
  logger: Logger;
  accounts: Accounts;
  tenants: Tenants;
  apiKeys: ApiKeys;
  tenantKeys: ReturnType<typeof createTenantKeyProvider>;
  verifyClientToken: TokenVerifier;
  docs: DocService;
  pubsub: PubSub;
  presence: Presence;
  ring: ShardRing;
  quotas: QuotaService;
  counters: UsageCounters;
  limiter: Limiter;
  /** Used for the per-connection message bucket, which needs no Redis hop. */
  localLimiter: InProcessLimiter;
  webhooks: Webhooks;
  stop(): Promise<void>;
}

export function createServices(cfg: Config, deps: Deps, logger: Logger): Services {
  const encryptionKey = parseEncryptionKey(cfg.ENCRYPTION_KEY);
  const onErr = (what: string) => (e: unknown) => {
    logger.warn({ err: e }, what);
  };

  const accounts = new Accounts(deps.control, {
    jwtSecret: cfg.JWT_ACCESS_SECRET,
    encryptionKey,
    defaultPlan: cfg.BILLING_ENABLED ? 'free' : cfg.DEFAULT_PLAN,
  });
  const apiKeys = new ApiKeys(deps.control);
  const tenantKeys = createTenantKeyProvider(deps.control, encryptionKey);
  const counters = new UsageCounters(deps.redis, undefined, onErr('usage counter failed'));
  const limiter = new RedisLimiter(deps.redis, {
    expectedNodes: cfg.RL_EXPECTED_NODES,
    onFallback: () => undefined,
  });

  const webhooks = new Webhooks(deps.control, {
    encryptionKey,
    allowPrivate: cfg.WEBHOOK_ALLOW_PRIVATE,
    maxEndpoints: async (tid) => (await quotas.limitsFor(tid)).webhooks,
  });
  const quotas = new QuotaService(deps.control, counters, {
    billingEnabled: cfg.BILLING_ENABLED,
    ttlMs: cfg.QUOTA_CACHE_MS,
    onEvent: (e) => {
      webhooks
        .emit(e.tenantId, e.type, {
          metric: e.metric,
          used: e.used,
          limit: e.limit,
          ...(e.type === 'quota.warning' ? { percent: 80 } : {}),
        })
        .catch(onErr('quota webhook failed'));
    },
  });

  const tenants = new Tenants(
    deps.control,
    {
      onPlanChange: (id) => {
        quotas.invalidate(id);
        tenantKeys.invalidate(id);
      },
      mail: (to, url) => {
        // Console mailer (AUT-09): email delivery is out of scope; the link is also returned to the inviter.
        logger.info({ to, url }, 'invitation link');
      },
    },
    cfg.PUBLIC_URL,
  );

  const ring = new ShardRing(deps.shards.length);
  const pubsub = new RedisPubSub(deps.redis, onErr('pubsub error'));
  const presence = new Presence(deps.redis, pubsub, cfg.NODE_ID);
  const docs = new DocService({
    ring,
    nodeId: cfg.NODE_ID,
    pubsub,
    onError: (what, e) => {
      logger.warn({ err: e }, what);
    },
    shards: deps.shards,
    cacheMax: cfg.HOT_DOC_CACHE_MAX,
    cacheIdleMs: cfg.HOT_DOC_IDLE_MS,
    batchWindowMs: cfg.BATCH_WINDOW_MS,
    batchMaxBytes: cfg.BATCH_MAX_BYTES,
    maxUpdateBytes: cfg.MAX_UPDATE_BYTES,
    hooks: {
      gapRecovered: () => {
        gapRecoveries.labels(cfg.NODE_ID).inc();
      },
      checkCreate: (tid) => quotas.checkCreateDocument(tid),
      checkWrite: async (tid, w) => {
        const limits = await quotas.limitsFor(tid);
        if (limits.opsPerSecond !== null) {
          const r = await limiter.take(`tenant:${tid}`, {
            capacity: limits.opsPerSecond,
            ratePerSec: limits.opsPerSecond,
          });
          if (!r.allowed) {
            throw new SyncraError('RATE_LIMITED', 'Tenant write rate exceeded', {
              scope: 'tenant',
              retryAfterMs: r.retryAfterMs,
            });
          }
        }
        await quotas.checkWrite(tid, w);
      },
      accepted: (tid, bytes) => {
        opsReceived.inc();
        quotas.recordWrite(tid, bytes).catch(onErr('usage record failed'));
      },
      created: (tid, collection, docId) => {
        quotas.recordDocumentCreated(tid).catch(onErr('usage record failed'));
        webhooks
          .emit(tid, 'document.created', { collection, docId })
          .catch(onErr('webhook emit failed'));
      },
      deleted: (tid, collection, docId) => {
        webhooks
          .emit(tid, 'document.deleted', { collection, docId })
          .catch(onErr('webhook emit failed'));
      },
      committed: (tid, collection, docId, info) => {
        webhooks.emitUpdatedDebounced(
          tid,
          collection,
          docId,
          info.seq,
          onErr('webhook emit failed'),
        );
      },
    },
  });

  const lastUsed = setInterval(() => {
    apiKeys.flushLastUsed().catch(onErr('last_used flush failed'));
  }, 30_000);
  lastUsed.unref();

  return {
    cfg,
    deps,
    logger,
    accounts,
    tenants,
    apiKeys,
    tenantKeys,
    verifyClientToken: createClientTokenVerifier(tenantKeys),
    docs,
    pubsub,
    presence,
    ring,
    quotas,
    counters,
    limiter,
    localLimiter: new InProcessLimiter(),
    webhooks,
    async stop() {
      clearInterval(lastUsed);
      await pubsub.close();
      webhooks.stop();
      await apiKeys.flushLastUsed().catch(onErr('last_used flush failed'));
    },
  };
}
