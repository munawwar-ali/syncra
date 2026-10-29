/** Common Zod schemas and limits shared by server, worker and SDK (Doc 03 §1, §10). */
import { z } from 'zod';

export const DOC_ID_REGEX = /^[A-Za-z0-9_.:-]{1,128}$/;
export const COLLECTION_REGEX = /^[a-z][a-z0-9_-]{0,63}$/;

/** SDK index documents live in the reserved collection `__index` (Doc 03 §10). */
export const INDEX_COLLECTION = '__index';

export const docIdSchema = z.string().regex(DOC_ID_REGEX);
export const collectionSchema = z.string().regex(COLLECTION_REGEX);

export const PAGE_DEFAULT_LIMIT = 50;
export const PAGE_MAX_LIMIT = 200;

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(PAGE_MAX_LIMIT).default(PAGE_DEFAULT_LIMIT),
  cursor: z.string().optional(),
});

export const LIMITS = {
  maxUpdateBytes: 1_048_576,
  maxMessageBytes: 2_097_152,
  maxRestBodyBytes: 1_048_576,
  maxSubscriptionsPerConnection: 200,
  maxAwarenessBytes: 8192,
  maxTokenTtlSeconds: 86_400,
  maxTokenMetaBytes: 2048,
} as const;
