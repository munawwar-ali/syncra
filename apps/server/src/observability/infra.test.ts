/**
 * Guards the monitoring configuration (OPS-08): the alert rules, Grafana dashboard and Prometheus config
 * must parse, and every metric they use must be one the code actually exposes. Without this, a renamed
 * metric would leave an alert that never fires and a panel that is always empty.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const read = (p: string): string => readFileSync(join(root, p), 'utf8');

function sourceFiles(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const rel = join(dir, name);
    if (name === 'node_modules' || name === 'dist') return [];
    return statSync(join(root, rel)).isDirectory()
      ? sourceFiles(rel)
      : /\.ts$/.test(name) && !/\.test\.ts$/.test(name)
        ? [rel]
        : [];
  });
}

/** Metric names declared in server and worker code (`name: 'syncra_x'`), plus the HTTP histogram. */
const declared = new Set(
  [...sourceFiles('apps/server/src'), ...sourceFiles('apps/worker/src')].flatMap((f) =>
    [...read(f).matchAll(/name:\s*'((?:syncra_|http_)[a-z0-9_]+)'/g)].map((m) => m[1] as string),
  ),
);

/** Metric names used in a PromQL expression, with histogram suffixes folded back to the base name. */
const used = (expr: string): string[] =>
  [...expr.matchAll(/\b((?:syncra_|http_request_)[a-z0-9_]+)/g)].map((m) =>
    (m[1] as string).replace(/_(bucket|sum|count)$/, ''),
  );

describe('monitoring configuration (OPS-08)', () => {
  it('declares the metrics from Doc 02 section 14.1 that this phase implements', () => {
    for (const name of [
      'syncra_ws_connections',
      'syncra_ops_received_total',
      'syncra_ops_committed_total',
      'syncra_op_commit_duration_seconds',
      'syncra_ack_latency_seconds',
      'syncra_fanout_lag_seconds',
      'syncra_hot_docs',
      'syncra_gap_recoveries_total',
      'syncra_rate_limited_total',
      'syncra_quota_blocked_total',
      'syncra_backpressure_events_total',
      'syncra_compaction_rows_deleted_total',
      'syncra_compaction_bytes_reclaimed_total',
      'syncra_compaction_verify_failures_total',
      'syncra_queue_depth',
      'syncra_pg_pool_waiting',
      'syncra_ops_since_snapshot_max',
      'http_request_duration_seconds',
    ]) {
      expect(declared, name).toContain(name);
    }
  });

  it('keeps tenant and document identifiers out of metric labels (cardinality rule)', () => {
    const labels = [...sourceFiles('apps/server/src'), ...sourceFiles('apps/worker/src')].flatMap(
      (f) =>
        [...read(f).matchAll(/labelNames:\s*\[([^\]]*)\]/g)].map(
          (m) => `${relative('.', f)}: ${m[1] as string}`,
        ),
    );
    expect(labels.length).toBeGreaterThan(5);
    for (const l of labels) expect(l, l).not.toMatch(/tenant|doc|user|client/i);
  });

  it('alert rules parse and only reference metrics that exist', () => {
    const doc = parse(read('infra/prometheus/alerts.yml')) as {
      groups: { rules: { alert: string; expr: string }[] }[];
    };
    const rules = doc.groups.flatMap((g) => g.rules);
    expect(rules.map((r) => r.alert).sort()).toEqual(
      [
        'AckLatencyHigh',
        'CompactionVerificationFailed',
        'ConnectionsDropped',
        'GapRecoveriesHigh',
        'PostgresPoolWaiting',
        'QueueBacklog',
        'SnapshotBacklog',
      ].sort(),
    );
    for (const r of rules) {
      const names = used(r.expr);
      expect(names.length, r.alert).toBeGreaterThan(0);
      for (const n of names) expect(declared, `${r.alert} uses ${n}`).toContain(n);
    }
  });

  it('the Grafana dashboard is valid JSON with the required panels, all backed by real metrics', () => {
    const d = JSON.parse(read('infra/grafana/dashboards/syncra.json')) as {
      panels: { title: string; targets: { expr: string }[] }[];
    };
    const titles = d.panels.map((p) => p.title.toLowerCase()).join(' | ');
    for (const need of [
      'connections',
      'operations',
      'ack latency',
      'fan-out',
      'hot documents',
      'backlog',
      'compaction',
      'rate limit',
    ]) {
      expect(titles, need).toContain(need);
    }
    for (const p of d.panels) {
      expect(p.targets.length, p.title).toBeGreaterThan(0);
      for (const t of p.targets)
        for (const n of used(t.expr)) expect(declared, `${p.title} uses ${n}`).toContain(n);
    }
  });

  it('Prometheus scrapes the server replicas and the worker, and loads the alert rules', () => {
    const cfg = parse(read('infra/prometheus/prometheus.yml')) as {
      rule_files: string[];
      scrape_configs: { job_name: string; dns_sd_configs?: { names: string[]; port: number }[] }[];
    };
    const jobs = Object.fromEntries(
      cfg.scrape_configs.map((j) => [j.job_name, j.dns_sd_configs?.[0]]),
    );
    expect(jobs['syncra-server']).toMatchObject({ names: ['server'], port: 8080 });
    expect(jobs['syncra-worker']).toMatchObject({ names: ['worker'], port: 9100 });
    expect(cfg.rule_files).toContain('/etc/prometheus/alerts.yml');
  });

  it('Grafana provisioning points at the Prometheus datasource the dashboard uses', () => {
    const ds = parse(read('infra/grafana/provisioning/datasources/prometheus.yml')) as {
      datasources: { uid: string; url: string }[];
    };
    expect(ds.datasources[0]).toMatchObject({
      uid: 'syncra-prometheus',
      url: 'http://prometheus:9090',
    });
    expect(read('infra/grafana/dashboards/syncra.json')).toContain('syncra-prometheus');
    const compose = parse(read('infra/compose/docker-compose.yml')) as {
      services: Record<string, { volumes?: string[] }>;
    };
    expect(compose.services.grafana?.volumes?.join(' ')).toContain('provisioning');
    expect(Object.keys(compose.services)).toEqual(
      expect.arrayContaining(['prometheus', 'grafana', 'toxiproxy', 'k6']),
    );
  });
});
