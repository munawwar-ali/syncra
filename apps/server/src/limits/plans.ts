/** Plan definitions and quotas (Doc 01 §5). `null` means unlimited. */

export type PlanName = 'free' | 'pro' | 'business' | 'selfhost';
export type QuotaMetric = 'documents' | 'storage' | 'ops' | 'connections' | 'doc_size';

export interface PlanLimits {
  documents: number | null;
  storageBytes: number | null;
  opsPerMonth: number | null;
  connections: number | null;
  historyDays: number;
  maxDocBytes: number;
  webhooks: number | null;
  opsPerSecond: number | null;
  /** Monthly base fee and overage prices, in integer cents (Doc 01 §5). */
  baseCents: number;
  overage: { perMillionOpsCents: number; perGbStorageCents: number } | null;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

export const PLANS: Record<PlanName, PlanLimits> = {
  free: {
    documents: 1_000,
    storageBytes: 100 * MB,
    opsPerMonth: 1_000_000,
    connections: 100,
    historyDays: 7,
    maxDocBytes: 5 * MB,
    webhooks: 1,
    opsPerSecond: 50,
    baseCents: 0,
    overage: null, // free is hard-capped
  },
  pro: {
    documents: 100_000,
    storageBytes: 10 * GB,
    opsPerMonth: 50_000_000,
    connections: 5_000,
    historyDays: 30,
    maxDocBytes: 25 * MB,
    webhooks: 10,
    opsPerSecond: 1_000,
    baseCents: 2_900,
    overage: { perMillionOpsCents: 40, perGbStorageCents: 25 },
  },
  business: {
    documents: 1_000_000,
    storageBytes: 100 * GB,
    opsPerMonth: 500_000_000,
    connections: 50_000,
    historyDays: 90,
    maxDocBytes: 50 * MB,
    webhooks: 50,
    opsPerSecond: 10_000,
    baseCents: 14_900,
    overage: { perMillionOpsCents: 40, perGbStorageCents: 25 },
  },
  selfhost: {
    documents: null,
    storageBytes: null,
    opsPerMonth: null,
    connections: null,
    historyDays: 30,
    maxDocBytes: 50 * MB,
    webhooks: null,
    opsPerSecond: null,
    baseCents: 0,
    overage: null,
  },
};

/** With billing disabled every tenant is treated as selfhost (BIL-05): nothing ever blocks. */
export const effectivePlan = (plan: PlanName, billingEnabled: boolean): PlanLimits =>
  PLANS[billingEnabled ? plan : 'selfhost'];
