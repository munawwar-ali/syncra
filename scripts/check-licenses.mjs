// P6-T10: fail if a production dependency has a copyleft or unknown license. Run: node scripts/check-licenses.mjs
import { execSync } from 'node:child_process';

const DENY = /\b(A?GPL|LGPL|SSPL|BUSL|CC-BY-NC|Commons Clause)\b/i;
// Reviewed exceptions: package -> reason. Keep this list short.
const ALLOW = {};

const out = JSON.parse(execSync('pnpm licenses list --prod --json', { encoding: 'utf8', maxBuffer: 1 << 28 }));
const bad = [];
let count = 0;
for (const [license, pkgs] of Object.entries(out)) {
  for (const p of pkgs) {
    count++;
    const known = license && !/^(unknown|unlicensed)$/i.test(license);
    if ((!known || DENY.test(license)) && !(p.name in ALLOW)) bad.push(`${p.name}@${p.versions?.join(',')}: ${license}`);
  }
}
console.log(`checked ${count} production packages`);
if (bad.length) {
  console.error(`license problems:\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
console.log('licenses ok');
