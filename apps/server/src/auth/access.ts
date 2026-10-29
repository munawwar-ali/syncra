/** Access rules carried in client-token claims (Doc 01 AUT-06, Doc 03 §4.2). */
import { z } from 'zod';
import { INDEX_COLLECTION } from '@syncra/shared';

export const accessRuleSchema = z.object({
  collection: z.string(),
  docs: z.union([z.literal('*'), z.array(z.string())]),
  mode: z.enum(['r', 'rw']),
});
export type AccessRule = z.infer<typeof accessRuleSchema>;

/**
 * Highest mode granted for the document, or null. 'rw' wins over 'r'. The SDK's index document
 * `__index/{c}` is readable with any rule on collection `c`, writable only with a wildcard rw rule.
 */
export function resolveAccess(
  rules: readonly AccessRule[],
  collection: string,
  docId: string,
): 'r' | 'rw' | null {
  if (collection === INDEX_COLLECTION) {
    const own = rules.filter((r) => r.collection === docId);
    if (own.some((r) => r.docs === '*' && r.mode === 'rw')) return 'rw';
    return own.length > 0 ? 'r' : null;
  }
  let result: 'r' | 'rw' | null = null;
  for (const rule of rules) {
    if (rule.collection !== collection) continue;
    if (rule.docs !== '*' && !rule.docs.includes(docId)) continue;
    if (rule.mode === 'rw') return 'rw';
    result = 'r';
  }
  return result;
}
