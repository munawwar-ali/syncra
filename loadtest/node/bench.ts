/**
 * Local load runner. Starts the server as a SEPARATE process (embedded PostgreSQL, in-memory Redis
 * stand-in, one node), drives it over real WebSockets, and writes result files to loadtest/results/.
 *
 *   pnpm --filter @syncra/loadtest bench steady --clients 1000 --hold 60
 *   pnpm --filter @syncra/loadtest bench hotdoc --subscribers 300
 *   pnpm --filter @syncra/loadtest bench delta
 *
 * Read the caveats written into every result file: the generator and the server share one machine, there
 * is one node, and Redis is emulated. These numbers describe this setup, not a three-node deployment.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import {
  MSG,
  clockLength,
  findTimestamp,
  frame,
  percentile,
  pingFrame,
  readHeader,
  subscribeFrame,
  textInsertUpdate,
  updateFrame,
  writeVarBytes,
  writeVarUint,
} from '../k6/lib.js';

const ROOT = join(import.meta.dirname, '..', '..');
const PORT = Number(process.env.BENCH_PORT ?? 19080);
const PG_PORT = Number(process.env.BENCH_PG_PORT ?? 54340);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const scenario = args[0] ?? 'steady';
const opt = (name: string, def: number): number => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : def;
};

// ---- server process ------------------------------------------------------------------------

interface Server {
  child: ChildProcess;
  pid: number;
  base: string;
  stop(): Promise<void>;
}

function listenerPid(port: number): number {
  if (process.platform === 'win32') {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `(Get-NetTCPConnection -LocalPort ${String(port)} -State Listen | Select-Object -First 1).OwningProcess`,
      ],
      { encoding: 'utf8' },
    );
    return Number(out.trim());
  }
  return Number(
    execFileSync('sh', ['-c', `lsof -ti tcp:${String(port)} -sTCP:LISTEN | head -n1`], {
      encoding: 'utf8',
    }).trim(),
  );
}

function cpuSeconds(pid: number): { cpu: number; rssMb: number } {
  if (process.platform === 'win32') {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `$p = Get-Process -Id ${String(pid)}; "$($p.CPU) $($p.WorkingSet64)"`,
      ],
      { encoding: 'utf8' },
    );
    const [cpu, ws] = out.trim().split(/\s+/).map(Number);
    return { cpu: cpu ?? 0, rssMb: (ws ?? 0) / 1024 / 1024 };
  }
  const out = execFileSync('ps', ['-o', 'cputime=,rss=', '-p', String(pid)], { encoding: 'utf8' })
    .trim()
    .split(/\s+/);
  const [h = 0, m = 0, s = 0] = (out[0] ?? '0:0:0').split(':').map(Number);
  return { cpu: h * 3600 + m * 60 + s, rssMb: Number(out[1] ?? 0) / 1024 };
}

async function startServer(): Promise<Server> {
  const child = spawn('pnpm', ['exec', 'tsx', 'scripts/local-stack.ts'], {
    cwd: ROOT,
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      PORT: String(PORT),
      LOCAL_PG_PORT: String(PG_PORT),
      LOCAL_JOBS: 'false',
      LOG_LEVEL: 'error',
      // One load-generator IP opens thousands of sockets; the default 20/s per-IP admission would throttle it.
      RL_IP_RATE: '100000',
      // The 100 msg/s per-connection default is far above one update per 5 s, so it is left alone.
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(d));
  const base = `http://127.0.0.1:${String(PORT)}`;
  for (let i = 0; i < 180; i++) {
    try {
      if ((await fetch(`${base}/readyz`)).ok) break;
    } catch {
      // not up yet
    }
    await sleep(500);
    if (i === 179) throw new Error('server did not become ready');
  }
  const pid = listenerPid(PORT);
  return {
    child,
    pid,
    base,
    async stop() {
      try {
        if (process.platform === 'win32')
          execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        else child.kill('SIGTERM');
      } catch {
        // already gone
      }
      await sleep(500);
    },
  };
}

async function token(base: string, name: string): Promise<string> {
  const r = await fetch(`${base}/demo/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return ((await r.json()) as { token: string }).token;
}

// ---- a protocol client ----------------------------------------------------------------------

interface Stats {
  connectMs: number[];
  ackMs: number[];
  propagationMs: number[];
  opsSent: number;
  acks: number;
  errors: number;
  closes: number;
  connected: number;
}
const newStats = (): Stats => ({
  connectMs: [],
  ackMs: [],
  propagationMs: [],
  opsSent: 0,
  acks: 0,
  errors: 0,
  closes: 0,
  connected: 0,
});

class Device {
  private ws: WebSocket | undefined;
  private clock = 0;
  private n = 0;
  private readonly pending = new Map<string, number>();
  private timers: ReturnType<typeof setInterval>[] = [];
  readonly clientNum = Math.floor(Math.random() * 4_000_000_000) + 1;
  open = false;

  constructor(
    private readonly url: string,
    private readonly tok: string,
    private readonly docKey: string,
    private readonly stats: Stats,
  ) {}

  connect(): Promise<void> {
    const t0 = performance.now();
    return new Promise((resolve) => {
      const ws = new WebSocket(
        `${this.url}/v1/connect?clientId=bench-${String(this.clientNum)}&token=${this.tok}&v=1`,
      );
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      let settled = false;
      const done = (): void => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      ws.onopen = () => {
        this.open = true;
        this.stats.connected++;
        this.stats.connectMs.push(performance.now() - t0);
        ws.send(subscribeFrame(this.docKey));
        this.timers.push(setInterval(() => ws.send(pingFrame()), 25_000));
        done();
      };
      ws.onmessage = (e: MessageEvent<ArrayBuffer>) => this.onMessage(new Uint8Array(e.data));
      ws.onerror = () => {
        this.stats.errors++;
        done();
      };
      ws.onclose = () => {
        if (this.open) this.stats.closes++;
        this.open = false;
        done();
      };
    });
  }

  private onMessage(buf: Uint8Array): void {
    const h = readHeader(buf);
    if (h.type === MSG.ACK) {
      const len = buf[h.offset] as number;
      let opId = '';
      for (let i = 0; i < len; i++) opId += String.fromCharCode(buf[h.offset + 1 + i] as number);
      const sent = this.pending.get(opId);
      if (sent !== undefined) {
        this.stats.ackMs.push(performance.now() - sent);
        this.stats.acks++;
        this.pending.delete(opId);
      }
    } else if (h.type === MSG.UPDATE_BROADCAST) {
      const ts = findTimestamp(buf);
      if (ts !== null) this.stats.propagationMs.push(Date.now() - ts);
    } else if (h.type === MSG.ERROR) {
      this.stats.errors++;
    }
  }

  /** Sends one timestamped update now. */
  write(): void {
    if (!this.open || !this.ws) return;
    const text = `T${String(Date.now())}|${String(this.n)}`;
    const opId = `${String(this.clientNum)}:${String(this.n++)}`;
    this.pending.set(opId, performance.now());
    this.ws.send(
      updateFrame(this.docKey, opId, textInsertUpdate(this.clientNum, this.clock, text)),
    );
    this.clock += clockLength(text);
    this.stats.opsSent++;
  }

  writeEvery(ms: number, offset: number): void {
    setTimeout(() => {
      this.timers.push(setInterval(() => this.write(), ms));
    }, offset);
  }

  close(): void {
    this.timers.forEach(clearInterval);
    this.ws?.close();
  }
}

// ---- measurement ----------------------------------------------------------------------------

const dist = (v: number[]) => ({
  count: v.length,
  p50: round(percentile(v, 0.5)),
  p95: round(percentile(v, 0.95)),
  p99: round(percentile(v, 0.99)),
  max: round(v.length ? Math.max(...v) : 0),
});
const round = (n: number): number => Math.round(n * 100) / 100;

function environment() {
  let sha = 'unknown';
  try {
    sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    if (execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim())
      sha += '+dirty';
  } catch {
    // not a git checkout
  }
  return {
    gitSha: sha,
    date: new Date().toISOString(),
    cpu: os.cpus()[0]?.model.trim() ?? 'unknown',
    logicalCores: os.cpus().length,
    ramGb: Math.round(os.totalmem() / 2 ** 30),
    os: `${os.platform()} ${os.release()}`,
    node: process.version,
    topology:
      '1 sync node (separate process) + embedded PostgreSQL 16 (control + 2 shards) + in-memory Redis stand-in; load generator on the same machine',
  };
}

const CAVEATS = [
  'Load generator and server run on the same machine and compete for CPU; the numbers are pessimistic for the server and say nothing about network latency.',
  'One sync node only. Multi-node fan-out, reconnect storms and node-failure recovery need the Docker stack and are NOT measured here.',
  'Redis is an in-process stand-in (ioredis-mock) and Postgres is an embedded build, so absolute throughput is not representative of managed services.',
  'Propagation latency is measured between two sockets of the same load-generator process, so both sides share one clock.',
];

function writeResults(
  name: string,
  config: Record<string, unknown>,
  results: Record<string, unknown>,
): void {
  const env = environment();
  const dir = join(ROOT, 'loadtest', 'results');
  mkdirSync(dir, { recursive: true });
  // BENCH_TAG distinguishes repeated runs of one scenario (run1, run2, ...), so none overwrites another.
  const tag = process.env.BENCH_TAG ? `-${process.env.BENCH_TAG}` : '';
  const base = join(dir, `${env.date.slice(0, 10)}-${name}${tag}`);
  writeFileSync(
    `${base}.json`,
    `${JSON.stringify({ scenario: name, environment: env, config, results, caveats: CAVEATS }, null, 2)}\n`,
  );
  const md = [
    `# ${name} - ${env.date.slice(0, 10)}`,
    '',
    `Git: \`${env.gitSha}\` | ${env.cpu}, ${String(env.logicalCores)} logical cores, ${String(env.ramGb)} GB RAM | ${env.os} | Node ${env.node}`,
    '',
    `Topology: ${env.topology}`,
    '',
    '## Configuration',
    '',
    '```json',
    JSON.stringify(config, null, 2),
    '```',
    '',
    '## Results',
    '',
    '```json',
    JSON.stringify(results, null, 2),
    '```',
    '',
    '## Caveats',
    '',
    ...CAVEATS.map((c) => `- ${c}`),
    '',
  ].join('\n');
  writeFileSync(`${base}.md`, md);
  console.log(`\nwrote ${base}.json and .md`);
  console.log(JSON.stringify(results, null, 2));
}

async function measureServer<T>(
  srv: Server,
  run: () => Promise<T>,
): Promise<{ value: T; cpuPercentOfOneCore: number; peakRssMb: number }> {
  const before = cpuSeconds(srv.pid);
  const t0 = performance.now();
  let peak = before.rssMb;
  const sampler = setInterval(() => {
    try {
      peak = Math.max(peak, cpuSeconds(srv.pid).rssMb);
    } catch {
      // process gone
    }
  }, 5000);
  const value = await run();
  clearInterval(sampler);
  const after = cpuSeconds(srv.pid);
  const wall = (performance.now() - t0) / 1000;
  return {
    value,
    cpuPercentOfOneCore: round(((after.cpu - before.cpu) / wall) * 100),
    peakRssMb: round(Math.max(peak, after.rssMb)),
  };
}

/** Quantile estimate from a Prometheus histogram, summed over label sets (linear interpolation inside a bucket). */
function histogramQuantile(metricsText: string, name: string, q: number): number | null {
  const buckets = new Map<number, number>();
  for (const line of metricsText.split('\n')) {
    if (!line.startsWith(`${name}_bucket`)) continue;
    const le = /le="([^"]+)"/.exec(line)?.[1];
    const value = Number(line.slice(line.lastIndexOf(' ') + 1));
    if (le === undefined) continue;
    const bound = le === '+Inf' ? Infinity : Number(le);
    buckets.set(bound, (buckets.get(bound) ?? 0) + value);
  }
  const sorted = [...buckets].sort((a, b) => a[0] - b[0]);
  const total = sorted.at(-1)?.[1] ?? 0;
  if (total === 0) return null;
  const rank = q * total;
  let prevBound = 0;
  let prevCount = 0;
  for (const [bound, count] of sorted) {
    if (count >= rank) {
      if (!Number.isFinite(bound)) return prevBound * 1000;
      const span = count - prevCount;
      return (prevBound + ((bound - prevBound) * (rank - prevCount)) / (span || 1)) * 1000;
    }
    prevBound = bound;
    prevCount = count;
  }
  return null;
}

/** The server's own view of latency (milliseconds), taken from its /metrics histograms. */
async function serverSide(base: string) {
  const text = await (await fetch(`${base}/metrics`)).text();
  const q = (name: string) => ({
    p50: round(histogramQuantile(text, name, 0.5) ?? 0),
    p95: round(histogramQuantile(text, name, 0.95) ?? 0),
    p99: round(histogramQuantile(text, name, 0.99) ?? 0),
  });
  return {
    ackLatencyMs: q('syncra_ack_latency_seconds'),
    postgresCommitMs: q('syncra_op_commit_duration_seconds'),
    note: 'Histogram buckets, so values are estimates; the ack histogram covers the whole run including the ramp.',
  };
}

// ---- scenarios ------------------------------------------------------------------------------

async function steady(srv: Server): Promise<void> {
  const clients = opt('clients', 1000);
  const hold = opt('hold', 60);
  const rampPerSec = opt('ramp', 100);
  const everyMs = opt('every-ms', 5000);
  const stats = newStats();
  const url = srv.base.replace(/^http/, 'ws');
  const tok = await token(srv.base, 'bench');
  const devices: Device[] = [];

  const { cpuPercentOfOneCore, peakRssMb } = await measureServer(srv, async () => {
    const docs = Math.max(1, Math.floor(clients / 2));
    for (let i = 0; i < clients; i += rampPerSec) {
      const batch = Array.from({ length: Math.min(rampPerSec, clients - i) }, (_, k) => {
        const d = new Device(
          url,
          tok,
          `notes/steady-${String(Math.floor(Math.random() * docs))}`,
          stats,
        );
        devices.push(d);
        return d.connect().then(() => d.writeEvery(everyMs, Math.random() * everyMs + 1000 + k));
      });
      await Promise.all(batch);
      await sleep(1000);
    }
    console.log(
      `connected ${String(stats.connected)} of ${String(clients)}; holding ${String(hold)} s`,
    );
    // Only count what happens while all clients are connected and active.
    stats.ackMs.length = 0;
    stats.propagationMs.length = 0;
    const opsAtStart = stats.opsSent;
    await sleep(hold * 1000);
    (stats as Stats & { holdOps?: number }).holdOps = stats.opsSent - opsAtStart;
  });

  const holdOps = (stats as Stats & { holdOps?: number }).holdOps ?? 0;
  devices.forEach((d) => {
    d.close();
  });
  writeResults(
    'steady',
    {
      clients,
      holdSeconds: hold,
      updateEveryMs: everyMs,
      docs: Math.floor(clients / 2),
      rampPerSecond: rampPerSec,
    },
    {
      connected: stats.connected,
      unexpectedCloses: stats.closes,
      errors: stats.errors,
      connectMs: dist(stats.connectMs),
      opsPerSecondDuringHold: round(holdOps / hold),
      ackLatencyMs: dist(stats.ackMs),
      propagationMs: dist(stats.propagationMs),
      serverCpuPercentOfOneCore: cpuPercentOfOneCore,
      serverPeakRssMb: peakRssMb,
      serverSide: await serverSide(srv.base),
    },
  );
}

async function hotdoc(srv: Server): Promise<void> {
  const subscribers = opt('subscribers', 300);
  const writers = opt('writers', 10);
  const hold = opt('hold', 60);
  const rate = opt('rate', 5);
  const stats = newStats();
  const url = srv.base.replace(/^http/, 'ws');
  const tok = await token(srv.base, 'bench');
  const all: Device[] = [];

  const { cpuPercentOfOneCore, peakRssMb } = await measureServer(srv, async () => {
    for (let i = 0; i < subscribers; i += 100) {
      await Promise.all(
        Array.from({ length: Math.min(100, subscribers - i) }, () => {
          const d = new Device(url, tok, 'notes/hot', stats);
          all.push(d);
          return d.connect();
        }),
      );
      await sleep(500);
    }
    const writerDevices = Array.from(
      { length: writers },
      () => new Device(url, tok, 'notes/hot', stats),
    );
    all.push(...writerDevices);
    await Promise.all(writerDevices.map((d) => d.connect()));
    stats.ackMs.length = 0;
    stats.propagationMs.length = 0;
    writerDevices.forEach((d, i) => {
      d.writeEvery(1000 / rate, i * 20);
    });
    await sleep(hold * 1000);
  });

  all.forEach((d) => {
    d.close();
  });
  const expectedDeliveries = stats.opsSent * (subscribers + writers - 1);
  writeResults(
    'hot-doc',
    { subscribers, writers, writeRatePerWriter: rate, holdSeconds: hold },
    {
      connected: stats.connected,
      unexpectedCloses: stats.closes,
      errors: stats.errors,
      updatesSent: stats.opsSent,
      broadcastsReceived: stats.propagationMs.length,
      broadcastsExpectedIfNoBatchingOrDrops: expectedDeliveries,
      ackLatencyMs: dist(stats.ackMs),
      fanoutPropagationMs: dist(stats.propagationMs),
      serverCpuPercentOfOneCore: cpuPercentOfOneCore,
      serverPeakRssMb: peakRssMb,
      serverSide: await serverSide(srv.base),
    },
  );
}

/** Delta sync payload versus full state (benchmark 6), measured through the real server. */
async function delta(srv: Server): Promise<void> {
  const url = srv.base.replace(/^http/, 'ws');
  const tok = await token(srv.base, 'bench');
  const docKey = `notes/delta-${String(Date.now())}`;

  /** Opens a socket, subscribes, runs SYNC_STEP1 with `stateVector`, returns the bytes of the SYNC_STEP2 update. */
  const sync = (
    sv: Uint8Array,
    id: string,
    then?: (ws: WebSocket) => Promise<void>,
  ): Promise<number> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`${url}/v1/connect?clientId=${id}&token=${tok}&v=1`);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => ws.send(subscribeFrame(docKey));
      ws.onerror = () => reject(new Error('socket error'));
      ws.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        const buf = new Uint8Array(e.data);
        const h = readHeader(buf);
        if (h.type === MSG.SUBSCRIBED)
          ws.send(frame(MSG.SYNC_STEP1, docKey, (o) => writeVarBytes(o, sv)));
        if (h.type === MSG.SYNC_STEP2) {
          // fields: update (varUint8Array), seq
          let pos = h.offset;
          let len = 0;
          let mul = 1;
          for (;;) {
            const b = buf[pos++] as number;
            len += (b & 127) * mul;
            if (b < 128) break;
            mul *= 128;
          }
          void (then ? then(ws) : Promise.resolve()).then(() => {
            ws.close();
            resolve(len);
          });
        }
      };
    });

  // A writer builds a ~100 KB document.
  const doc = new Y.Doc();
  const ups: Uint8Array[] = [];
  doc.on('update', (u: Uint8Array) => ups.push(u));
  const text = doc.getText('t');
  for (let i = 0; i < 2000; i++)
    text.insert(
      text.length,
      'lorem ipsum dolor sit amet, consectetur adipiscing elit '.slice(0, 50) + String(i % 10),
    );
  // One merged frame per batch, like the SDK's 50 ms batching; thousands of tiny frames in one burst
  // would be (correctly) throttled by the per-connection rate limit and silently shrink the document.
  const pushAll = (ws: WebSocket, from: number): void => {
    ws.send(updateFrame(docKey, `batch-${String(from)}`, Y.mergeUpdates(ups.slice(from))));
  };
  await sync(new Uint8Array([0]), 'delta-writer', async (ws) => {
    pushAll(ws, 0);
    await sleep(1500);
  });
  const fullState = Y.encodeStateAsUpdate(doc);

  // A reader joins with an empty state vector and receives the full document.
  const fullBytes = await sync(Y.encodeStateVector(new Y.Doc()), 'delta-reader-1');
  // Self-check: the server must hold the whole document we built, otherwise the numbers are meaningless.
  if (Math.abs(fullBytes - fullState.length) > 64) {
    throw new Error(
      `server returned ${String(fullBytes)} bytes for a ${String(fullState.length)}-byte document; the writer's data was not fully stored`,
    );
  }

  // The reader goes offline; the writer makes 100 more edits; the reader returns with its old state vector.
  const readerState = new Y.Doc();
  Y.applyUpdate(readerState, fullState);
  const before = ups.length;
  for (let i = 0; i < 100; i++) text.insert(Math.floor(text.length / 2), `E${String(i)}`);
  await sync(new Uint8Array([0]), 'delta-writer-2', async (ws) => {
    pushAll(ws, before);
    await sleep(1000);
  });
  const deltaBytes = await sync(Y.encodeStateVector(readerState), 'delta-reader-2');
  const expectedDelta = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(readerState)).length;
  if (Math.abs(deltaBytes - expectedDelta) > 64) {
    throw new Error(
      `delta was ${String(deltaBytes)} bytes, expected about ${String(expectedDelta)}; the offline edits were not fully stored`,
    );
  }

  writeResults(
    'delta-sync',
    { documentCharacters: text.length, offlineEdits: 100 },
    {
      documentStateBytes: fullState.length,
      fullStateBytesOnWire: fullBytes,
      deltaBytesOnWire: deltaBytes,
      deltaAsPercentOfFull: round((deltaBytes / fullBytes) * 100),
      reductionFactor: round(fullBytes / Math.max(1, deltaBytes)),
    },
  );
}

/**
 * Compaction effect (benchmark 5): a document with 20,000 op rows (edits and deletions, so tombstones exist)
 * is loaded cold, snapshotted and compacted by the real worker job, and loaded cold again. No sync node is
 * involved: this measures the storage path (PostgreSQL + Yjs), so there is no network and no WebSocket.
 */
async function compaction(): Promise<void> {
  const EmbeddedPostgres = (await import('embedded-postgres')).default;
  const { mkdtempSync } = await import('node:fs');
  const pg = (await import('pg')).default;
  const RedisMock = (await import('ioredis-mock')).default as unknown as new (o: unknown) => never;
  const { migrateAll } = await import('../../apps/server/src/db/migrate.js');
  const { loadDoc, ensureDocument } = await import('../../apps/server/src/core/doc-store.js');
  const { maintainShard } = await import('../../apps/server/src/jobs/lifecycle.js');

  const edits = opt('ops', 20000);
  const port = PG_PORT + 1;
  const server = new EmbeddedPostgres({
    databaseDir: mkdtempSync(join(os.tmpdir(), 'syncra-bench-pg-')),
    user: 'syncra',
    password: 'syncra',
    port,
    persistent: false,
  });
  await server.initialise();
  await server.start();
  await server.createDatabase('control');
  await server.createDatabase('shard0');
  const url = (d: string): string => `postgres://syncra:syncra@127.0.0.1:${String(port)}/${d}`;
  await migrateAll(url('control'), [url('shard0')]);
  const pool = new pg.Pool({ connectionString: url('shard0'), max: 4 });
  try {
    const tenant = '00000000-0000-4000-8000-0000000000b1';
    const { uid } = await ensureDocument(pool, tenant, 'notes', 'heavy');

    // Build the edit history the way an editor produces it: mostly inserts, some deletions.
    const doc = new Y.Doc();
    const updates: Uint8Array[] = [];
    doc.on('update', (u: Uint8Array) => updates.push(u));
    const t = doc.getText('t');
    for (let i = 0; i < edits; i++) {
      t.insert(Math.floor((i * 7) % (t.length + 1)), 'ab');
      if (i % 3 === 0 && t.length > 4) t.delete(i % (t.length - 1), 1);
    }
    const used = updates.slice(0, edits);
    for (let from = 0; from < used.length; from += 2000) {
      const chunk = used.slice(from, from + 2000);
      await pool.query(
        `insert into operations (doc_uid, seq, tenant_id, client_id, op_refs, update, size)
         select $1, t.s, $2, 'seed', array['o' || t.s], t.u, length(t.u) from unnest($3::bigint[], $4::bytea[]) as t(s, u)`,
        [uid, tenant, chunk.map((_, i) => from + i + 1), chunk.map((u) => Buffer.from(u))],
      );
    }
    await pool.query(
      "update documents set head_seq = $2, updated_at = now() - interval '5 minutes', size_bytes = (select sum(size) from operations where doc_uid = $1) where uid = $1",
      [uid, used.length],
    );

    const measure = async () => {
      const times: number[] = [];
      let last: Awaited<ReturnType<typeof loadDoc>> | undefined;
      for (let i = 0; i < 7; i++) {
        const t0 = performance.now();
        last = await loadDoc(pool, tenant, uid);
        times.push(performance.now() - t0);
      }
      const rows = await pool.query<{ n: string; bytes: string }>(
        'select count(*)::text n, coalesce(sum(size),0)::text bytes from operations where doc_uid = $1',
        [uid],
      );
      const snaps = await pool.query<{ bytes: string }>(
        'select coalesce(sum(size),0)::text bytes from snapshots where doc_uid = $1',
        [uid],
      );
      return {
        coldLoadMs: {
          median: round(percentile(times, 0.5)),
          min: round(Math.min(...times)),
          max: round(Math.max(...times)),
          runs: times.length,
        },
        opRowsRead: last?.opsRead ?? 0,
        opRowsStored: Number(rows.rows[0]?.n),
        opBytesStored: Number(rows.rows[0]?.bytes),
        snapshotBytesStored: Number(snaps.rows[0]?.bytes),
        totalBytesStored: Number(rows.rows[0]?.bytes) + Number(snaps.rows[0]?.bytes),
        characters: last?.doc.getText('t').length ?? 0,
      };
    };

    const before = await measure();
    const t0 = performance.now();
    const stats = await maintainShard(pool, new RedisMock({ host: 'bench' }) as never, {
      everyOps: 500,
      everyBytes: 1_048_576,
      idleMs: 60_000,
      checkpointMs: 0,
      retentionDays: () => Promise.resolve(30),
    });
    const maintainMs = round(performance.now() - t0);
    const after = await measure();
    if (stats.verifyFailures > 0)
      throw new Error('compaction verification failed during the benchmark');
    if (after.characters !== before.characters)
      throw new Error('document content changed during compaction');

    writeResults(
      'compaction',
      {
        opRows: edits,
        editMix: 'insert 2 chars each; delete 1 char every 3rd edit',
        retentionDays: 30,
        driver: 'maintainShard (the worker job): checkpoint, snapshot, verify, delete covered ops',
      },
      {
        before,
        after,
        maintenancePassMs: maintainMs,
        job: stats,
        loadTimeReduction: round(
          before.coldLoadMs.median / Math.max(0.001, after.coldLoadMs.median),
        ),
        storedBytesReductionPercent: round(
          (1 - after.totalBytesStored / before.totalBytesStored) * 100,
        ),
      },
    );
  } finally {
    await pool.end();
    await server.stop();
  }
}

const SCENARIOS: Record<string, (s: Server) => Promise<void>> = {
  steady,
  hotdoc,
  delta,
  compaction: () => compaction(),
};
const NEEDS_SERVER = scenario !== 'compaction';

if (!SCENARIOS[scenario]) {
  console.error(`unknown scenario "${scenario}"; choose: ${Object.keys(SCENARIOS).join(', ')}`);
  process.exit(2);
}
// Referenced so the helper import stays used by the scenario code above.
void writeVarUint;

if (NEEDS_SERVER) {
  const server = await startServer();
  try {
    await (SCENARIOS[scenario] as (s: Server) => Promise<void>)(server);
  } finally {
    await server.stop();
  }
} else {
  await (SCENARIOS[scenario] as (s: never) => Promise<void>)(undefined as never);
}
process.exit(0);
