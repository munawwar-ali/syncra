#!/usr/bin/env bash
# One-URL site for static hosting (Vercel): landing page at /, apps under /notes/, /inspection/,
# /dashboard/, and docs under /docs/. Output: site/ (the same layout infra/docker/Dockerfile.web uses).
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf site && mkdir -p site
cp site-src/index.html site-src/logo.svg site/ && cp -r site-src/images site-src/logos site-src/audio site/
pnpm --filter @syncra/dashboard... build
pnpm --filter @syncra/dashboard exec vite build --base=/dashboard/ --outDir dist-site
pnpm --filter @syncra/demo-notes... build
pnpm --filter @syncra/demo-notes exec vite build --base=/notes/ --outDir dist-site
pnpm --filter @syncra/demo-inspection... build
pnpm --filter @syncra/demo-inspection exec vite build --base=/inspection/ --outDir dist-site
DOCS_BASE=/docs/ pnpm --filter @syncra/docs build
cp -r apps/dashboard/dist-site site/dashboard
cp -r apps/demo-notes/dist-site site/notes
cp -r apps/demo-inspection/dist-site site/inspection
cp -r docs/.vitepress/dist site/docs
