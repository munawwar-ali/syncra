/**
 * DEMO_MODE only: seeds the field-inspection demo (DEM-02, P6-T03) with 5,000 sites and three checklist
 * templates. Idempotent and safe on several nodes: the Yjs client id and the op ids are fixed, so a second
 * run produces the same updates, and the server deduplicates them by (clientId, opId).
 */
import * as Y from 'yjs';
import { DEMO_TENANT_ID } from '../control/seed.js';
import type { Services } from '../services.js';

export const SITE_COUNT = 5000;
const SEED_CLIENT = 'seed:inspection';
const STREETS = ['Harbor Rd', 'Mill Ln', 'Station St', 'Quarry Way', 'Foundry Ave', 'Canal Row'];
const KINDS = ['Warehouse', 'Substation', 'Depot', 'Plant', 'Tower', 'Pump house'];

export const TEMPLATES: Record<string, { name: string; items: string[] }> = {
  safety: {
    name: 'Site safety walk',
    items: [
      'Fire exits clear',
      'First aid kit stocked',
      'PPE available',
      'Signage visible',
      'Machinery guarded',
    ],
  },
  electrical: {
    name: 'Electrical check',
    items: [
      'Panels labelled',
      'No exposed wiring',
      'Earthing verified',
      'Emergency lighting works',
    ],
  },
  environment: {
    name: 'Environmental check',
    items: ['No visible leaks', 'Waste segregated', 'Spill kit present'],
  },
};

const pad = (n: number): string => String(n).padStart(4, '0');
export const siteId = (n: number): string => `site-${pad(n)}`;
export const siteTitle = (n: number): string =>
  `${KINDS[n % KINDS.length] as string} ${pad(n)} - ${String(10 + (n % 90))} ${STREETS[n % STREETS.length] as string}`;

/**
 * Fills one `__index/{collection}` document, one update per batch. All batches come from the same
 * Y.Doc so the fixed client id's clock keeps counting up (a second doc would restart at 0 and be ignored).
 */
function indexUpdates(entries: { id: string; title: string }[], batch: number): Uint8Array[] {
  const doc = new Y.Doc();
  doc.clientID = 1; // fixed: identical bytes on every run
  const out: Uint8Array[] = [];
  doc.on('update', (u: Uint8Array) => out.push(u));
  const map = doc.getMap<Y.Map<unknown>>('entries');
  for (let from = 0; from < entries.length; from += batch) {
    doc.transact(() => {
      for (const e of entries.slice(from, from + batch)) {
        const m = new Y.Map<unknown>();
        m.set('createdAt', 1_700_000_000_000);
        m.set('updatedAt', 1_700_000_000_000);
        m.set('title', e.title);
        map.set(e.id, m);
      }
    });
  }
  return out;
}

export async function seedInspectionDemo(s: Services): Promise<void> {
  const sitesIndex = await s.docs.open(DEMO_TENANT_ID, '__index', 'sites', true);
  if (sitesIndex.doc.getMap('entries').size >= SITE_COUNT) return;

  const sites = Array.from({ length: SITE_COUNT }, (_, n) => ({
    id: siteId(n),
    title: siteTitle(n),
  }));
  const updates = indexUpdates(sites, 500);
  for (const [i, u] of updates.entries()) {
    await s.docs.write(sitesIndex, SEED_CLIENT, `sites:${String(i)}`, u);
  }

  for (const [id, t] of Object.entries(TEMPLATES)) {
    const hot = await s.docs.open(DEMO_TENANT_ID, 'templates', id, true);
    const doc = new Y.Doc();
    doc.clientID = 1;
    doc.transact(() => {
      doc.getMap('data').set('name', t.name);
      doc.getMap('data').set('items', t.items);
    });
    await s.docs.write(hot, SEED_CLIENT, `template:${id}`, Y.encodeStateAsUpdate(doc));
  }
  const tplIndex = await s.docs.open(DEMO_TENANT_ID, '__index', 'templates', true);
  const tplUpdates = indexUpdates(
    Object.entries(TEMPLATES).map(([id, t]) => ({ id, title: t.name })),
    10,
  );
  for (const [i, u] of tplUpdates.entries()) {
    await s.docs.write(tplIndex, SEED_CLIENT, `templates:index:${String(i)}`, u);
  }
}
