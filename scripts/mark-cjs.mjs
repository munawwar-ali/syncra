// The packages are "type": "module"; the CommonJS build in dist/cjs needs its own marker.
import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('dist/cjs', { recursive: true });
writeFileSync('dist/cjs/package.json', '{"type":"commonjs"}\n');
