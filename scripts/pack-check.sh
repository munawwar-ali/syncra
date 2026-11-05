#!/usr/bin/env bash
# A6-3 / DX-01: pack the SDK packages and prove they install and run in a clean project (ESM, CJS, types).
# Run after `pnpm build`. Usage: scripts/pack-check.sh
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

for p in shared protocol client react; do
  (cd "$root/packages/$p" && pnpm pack --pack-destination "$tmp" >/dev/null)
done
if tar -tzf "$tmp"/syncra-client-*.tgz | grep -qE "\.test\.|\.fakes\."; then echo "FAIL: test files in the package"; exit 1; fi

mkdir "$tmp/sample" && cd "$tmp/sample"
echo '{"name":"sample","version":"1.0.0","private":true,"type":"module"}' > package.json
npm install --no-audit --no-fund "$tmp"/syncra-shared-*.tgz "$tmp"/syncra-protocol-*.tgz "$tmp"/syncra-client-*.tgz "$tmp"/syncra-react-*.tgz react@18 yjs typescript@5 @types/react@18 >/dev/null

cat > esm.mjs <<'JS'
import { createClient } from '@syncra/client';
import { useDoc } from '@syncra/react';
const c = createClient({ url: 'http://127.0.0.1:1', publishableKey: 'pk', getToken: async () => 'x', storage: 'memory', tabEnv: null });
const d = c.doc('notes', 'a'); await d.whenLoaded(); d.setFields({ title: 'hello' });
if (d.map().toJSON().title !== 'hello' || typeof useDoc !== 'function') throw new Error('esm failed');
await c.destroy(); console.log('esm ok');
JS
cat > cjs.cjs <<'JS'
const { createClient } = require('@syncra/client');
const { useDoc } = require('@syncra/react');
const c = createClient({ url: 'http://127.0.0.1:1', publishableKey: 'pk', getToken: async () => 'x', storage: 'memory', tabEnv: null });
if (typeof c.doc !== 'function' || typeof useDoc !== 'function') throw new Error('cjs failed');
c.destroy().then(() => { console.log('cjs ok'); process.exit(0); });
JS
cat > t.ts <<'TS'
import { createClient, type SyncStatus } from '@syncra/client';
const c = createClient({ url: 'x', publishableKey: 'pk', getToken: async () => 't' });
const s: SyncStatus = c.status;
// @ts-expect-error pendingOps is a number
const bad: string = s.pendingOps;
void bad;
TS
echo '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext","strict":true,"noEmit":true,"skipLibCheck":true,"lib":["ES2022","DOM"]},"files":["t.ts"]}' > tsconfig.json
node esm.mjs && node cjs.cjs && npx tsc -p . && echo "types ok"
echo "pack check passed"
