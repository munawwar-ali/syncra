/** Environment parsing and validation for the sync node (Doc 03 §9). Fails fast on bad config. */
import { z } from 'zod';
import { hostname } from 'node:os';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const int = (def: number) => z.coerce.number().int().positive().default(def);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(8080),
  NODE_ID: z.string().min(1).default(hostname()),
  PUBLIC_URL: z.string().url().default('http://localhost:8080'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  CONTROL_DATABASE_URL: z.string().url(),
  SHARD_DATABASE_URLS: z.string().min(1),
  REDIS_URL: z.string().url(),
  JWT_ACCESS_SECRET: z.string().min(32),
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64'),
  METRICS_TOKEN: z.string().default(''),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default(''),
  BILLING_ENABLED: bool.default('false'),
  DEFAULT_PLAN: z.enum(['free', 'pro', 'business', 'selfhost']).default('selfhost'),
  BATCH_WINDOW_MS: int(20),
  BATCH_MAX_BYTES: int(262_144),
  HOT_DOC_CACHE_MAX: int(500),
  HOT_DOC_IDLE_MS: int(60_000),
  MAX_UPDATE_BYTES: int(1_048_576),
  MAX_MESSAGE_BYTES: int(2_097_152),
  WS_OUTBOUND_HIGH_WATER: int(1_048_576),
  WS_SLOW_CLOSE_MS: int(15_000),
  RL_CONN_RATE: int(100),
  RL_CONN_BURST: int(200),
  RL_IP_RATE: int(20),
  RL_AUTH_PER_MIN: int(5),
});

export type Config = Omit<z.infer<typeof schema>, 'SHARD_DATABASE_URLS'> & {
  SHARD_DATABASE_URLS: string[];
};

/** Parses env into a typed Config; throws a readable error listing every bad variable. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const shards = parsed.data.SHARD_DATABASE_URLS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return { ...parsed.data, SHARD_DATABASE_URLS: shards };
}
