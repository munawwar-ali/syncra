/** Access rules carried in client-token claims (Doc 01 AUT-06, Doc 03 §4.2). */
import { z } from 'zod';

export const accessRuleSchema = z.object({
  collection: z.string(),
  docs: z.union([z.literal('*'), z.array(z.string())]),
  mode: z.enum(['r', 'rw']),
});
export type AccessRule = z.infer<typeof accessRuleSchema>;

/** Highest mode granted for the document, or null. 'rw' wins over 'r'. */
export function resolveAccess(
  rules: readonly AccessRule[],
  collection: string,
  docId: string,
): 'r' | 'rw' | null {
  let result: 'r' | 'rw' | null = null;
  for (const rule of rules) {
    if (rule.collection !== collection) continue;
    if (rule.docs !== '*' && !rule.docs.includes(docId)) continue;
    if (rule.mode === 'rw') return 'rw';
    result = 'r';
  }
  return result;
}
