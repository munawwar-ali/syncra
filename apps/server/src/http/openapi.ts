/**
 * OpenAPI 3.0 document for the REST API (DX-04). The list of operations is checked against the live route
 * table by a test, and request bodies and queries come from the same Zod schemas the routes validate with.
 * The WebSocket protocol is not REST; it is specified in docs/protocol.md.
 */
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';
import * as S from './schemas.js';

type Auth = 'public' | 'cookie' | 'dashboard' | 'secret' | 'secretOrDashboard' | 'client';

interface Op {
  summary: string;
  tag: string;
  auth: Auth;
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  /** Successful status code; defaults to 200. */
  ok?: number;
  /** Response media type when it is not JSON. */
  media?: string;
  /** Roles or conditions worth knowing, shown in the description. */
  note?: string;
}

const KEY_NOTE = 'Secret API key (`sk_...`) or a dashboard session.';

/** Single source of truth for what is documented. Keys are "METHOD /v1/path" exactly as Fastify registers them. */
export const OPERATIONS: Record<string, Op> = {
  'POST /v1/auth/signup': {
    summary: 'Create an account, an organization and its first API keys',
    tag: 'Account',
    auth: 'public',
    body: S.signupBody,
    ok: 201,
    note: 'The secret key is shown only in this response. Sets the refresh cookie.',
  },
  'POST /v1/auth/login': {
    summary: 'Log in',
    tag: 'Account',
    auth: 'public',
    body: S.loginBody,
    note: 'Sets the refresh cookie. Limited to 5 attempts per minute per IP.',
  },
  'POST /v1/auth/refresh': {
    summary: 'Rotate the refresh cookie and get a new access token',
    tag: 'Account',
    auth: 'cookie',
    note: 'Reusing an old refresh token revokes the whole token family.',
  },
  'POST /v1/auth/logout': {
    summary: 'Revoke the current session',
    tag: 'Account',
    auth: 'cookie',
    ok: 204,
  },
  'POST /v1/auth/accept-invite': {
    summary: 'Accept a team invitation',
    tag: 'Account',
    auth: 'public',
    body: S.acceptInviteBody,
    note: 'New users must supply name and password.',
  },
  'GET /v1/me': { summary: 'Current user and organizations', tag: 'Account', auth: 'dashboard' },

  'GET /v1/tenant': {
    summary: 'Organization details, role and quota usage',
    tag: 'Organization',
    auth: 'dashboard',
  },
  'PATCH /v1/tenant': {
    summary: 'Rename the organization or change its plan',
    tag: 'Organization',
    auth: 'dashboard',
    body: S.tenantPatchBody,
    note: 'Renaming: owner or admin. Changing the plan: owner only.',
  },
  'DELETE /v1/tenant': {
    summary: 'Delete the organization (soft delete)',
    tag: 'Organization',
    auth: 'dashboard',
    ok: 204,
    note: 'Owner only. Keys and sessions stop working immediately.',
  },
  'GET /v1/tenant/members': {
    summary: 'Members and pending invitations',
    tag: 'Organization',
    auth: 'dashboard',
  },
  'POST /v1/tenant/invitations': {
    summary: 'Invite a member',
    tag: 'Organization',
    auth: 'dashboard',
    body: S.inviteBody,
    ok: 201,
    note: 'Owner or admin. Returns the invitation link; e-mail delivery is not configured.',
  },
  'PATCH /v1/tenant/members/:userId': {
    summary: 'Change a member role',
    tag: 'Organization',
    auth: 'dashboard',
    body: S.memberRoleBody,
    note: 'Owner or admin. Only the owner can change an admin; the owner cannot be changed.',
  },
  'DELETE /v1/tenant/members/:userId': {
    summary: 'Remove a member',
    tag: 'Organization',
    auth: 'dashboard',
    ok: 204,
    note: 'Owner or admin.',
  },

  'GET /v1/keys': {
    summary: 'List API keys (prefix only)',
    tag: 'Keys and tokens',
    auth: 'dashboard',
  },
  'POST /v1/keys': {
    summary: 'Create an API key',
    tag: 'Keys and tokens',
    auth: 'dashboard',
    body: S.createKeyBody,
    ok: 201,
    note: 'The full key is returned once. Developers can create publishable keys only.',
  },
  'DELETE /v1/keys/:id': {
    summary: 'Revoke an API key',
    tag: 'Keys and tokens',
    auth: 'dashboard',
    ok: 204,
    note: 'Takes effect within 60 seconds on every node.',
  },
  'POST /v1/tokens': {
    summary: 'Mint a short-lived client token for an end user',
    tag: 'Keys and tokens',
    auth: 'secret',
    body: S.mintRequestSchema,
    note: 'Call from your backend. Maximum lifetime 24 hours. Access rules limit collections, documents and read/write mode.',
  },
  'POST /v1/tokens/playground': {
    summary: 'Mint a token limited to the playground collection',
    tag: 'Keys and tokens',
    auth: 'dashboard',
    body: S.playgroundTokenBody,
  },

  'GET /v1/audit': {
    summary: 'Audit log, or verify its hash chain with ?verify=true',
    tag: 'Audit',
    auth: 'dashboard',
    query: S.paginationSchema,
    note: 'Owner or admin.',
  },
  'GET /v1/usage/current': {
    summary: 'Plan and current quota usage',
    tag: 'Usage and billing',
    auth: 'secretOrDashboard',
  },
  'GET /v1/usage': {
    summary: 'Usage time series',
    tag: 'Usage and billing',
    auth: 'dashboard',
    query: S.usageQuery,
  },
  'GET /v1/invoices': {
    summary: 'List invoices',
    tag: 'Usage and billing',
    auth: 'dashboard',
    note: 'Owner or admin. Billing is simulated.',
  },
  'GET /v1/invoices/:id': { summary: 'One invoice', tag: 'Usage and billing', auth: 'dashboard' },
  'GET /v1/invoices/:id/html': {
    summary: 'Printable invoice page',
    tag: 'Usage and billing',
    auth: 'dashboard',
    media: 'text/html',
  },
  'GET /v1/invoices/:id/pdf': {
    summary: 'Invoice as a PDF',
    tag: 'Usage and billing',
    auth: 'dashboard',
    media: 'application/pdf',
  },

  'GET /v1/webhooks': { summary: 'List webhook endpoints', tag: 'Webhooks', auth: 'dashboard' },
  'POST /v1/webhooks': {
    summary: 'Add a webhook endpoint',
    tag: 'Webhooks',
    auth: 'dashboard',
    body: S.endpointInput,
    ok: 201,
    note: 'The signing secret (`whsec_...`) is returned once. Private network targets are rejected unless the operator allows them.',
  },
  'PATCH /v1/webhooks/:id': {
    summary: 'Update a webhook endpoint',
    tag: 'Webhooks',
    auth: 'dashboard',
    body: S.endpointPatch,
  },
  'DELETE /v1/webhooks/:id': {
    summary: 'Delete a webhook endpoint',
    tag: 'Webhooks',
    auth: 'dashboard',
    ok: 204,
  },
  'POST /v1/webhooks/:id/test': {
    summary: 'Queue a test event',
    tag: 'Webhooks',
    auth: 'dashboard',
    ok: 202,
  },
  'GET /v1/webhooks/:id/deliveries': {
    summary: 'Delivery log',
    tag: 'Webhooks',
    auth: 'dashboard',
  },
  'POST /v1/webhooks/deliveries/:id/retry': {
    summary: 'Retry a delivery now',
    tag: 'Webhooks',
    auth: 'dashboard',
    ok: 202,
  },

  'GET /v1/collections': {
    summary: 'List collections with document counts and sizes',
    tag: 'Documents',
    auth: 'secretOrDashboard',
  },
  'GET /v1/collections/:c/docs': {
    summary: 'List documents (cursor pagination, id prefix search)',
    tag: 'Documents',
    auth: 'secretOrDashboard',
    query: S.listDocsQuery,
  },
  'POST /v1/collections/:c/docs': {
    summary: 'Create a document',
    tag: 'Documents',
    auth: 'secretOrDashboard',
    body: S.createDocBody,
    ok: 201,
    note: '`initial` is written into the root map `data`.',
  },
  'GET /v1/collections/:c/docs/:id': {
    summary: 'Read a document as JSON',
    tag: 'Documents',
    auth: 'secretOrDashboard',
  },
  'GET /v1/collections/:c/docs/:id/state': {
    summary: 'Binary Yjs state of a document',
    tag: 'Documents',
    auth: 'secretOrDashboard',
    media: 'application/octet-stream',
  },
  'DELETE /v1/collections/:c/docs/:id': {
    summary: 'Soft-delete a document',
    tag: 'Documents',
    auth: 'secretOrDashboard',
    ok: 204,
    note: 'Permanently removed after 7 days.',
  },
  'GET /v1/collections/:c/docs/:id/history': {
    summary: 'History checkpoints',
    tag: 'History',
    auth: 'secretOrDashboard',
  },
  'GET /v1/collections/:c/docs/:id/history/:seq': {
    summary: 'Document as JSON at the nearest checkpoint at or before seq',
    tag: 'History',
    auth: 'secretOrDashboard',
  },
  'POST /v1/collections/:c/docs/:id/restore': {
    summary: 'Restore a checkpoint (non-destructive)',
    tag: 'History',
    auth: 'secretOrDashboard',
    body: S.restoreBody,
    note: 'Writes a new edit that sets the content back; history keeps every version.',
  },
  'GET /v1/collections/:c/docs/:id/ops': {
    summary: 'Stored operations (metadata only)',
    tag: 'History',
    auth: 'dashboard',
  },
  'GET /v1/collections/:c/docs/:id/export': {
    summary: 'Export as JSON or binary Yjs (?format=json|yjs)',
    tag: 'Documents',
    auth: 'secretOrDashboard',
  },

  'POST /v1/sync/:c/:id/pull': {
    summary: 'HTTP fallback: fetch what the client lacks',
    tag: 'HTTP sync fallback',
    auth: 'client',
    body: S.pullBody,
    note: 'Use when WebSockets are blocked. Same access checks and limits as the WebSocket.',
  },
  'POST /v1/sync/:c/:id/push': {
    summary: 'HTTP fallback: send an update',
    tag: 'HTTP sync fallback',
    auth: 'client',
    body: S.pushBody,
    note: 'Idempotent on (clientId, opId).',
  },

  'GET /v1/changes': {
    summary: 'Change feed page',
    tag: 'Change feed',
    auth: 'secretOrDashboard',
    query: S.changesQuery,
    note: 'Pass the returned nextCursor to continue without gaps or duplicates.',
  },
  'GET /v1/changes/stream': {
    summary: 'Change feed as Server-Sent Events',
    tag: 'Change feed',
    auth: 'secretOrDashboard',
    query: S.changesQuery,
    media: 'text/event-stream',
    note: 'Resume with the Last-Event-ID header.',
  },

  'GET /v1/monitor/stream': {
    summary: 'Live metrics, one event per second',
    tag: 'Monitor',
    auth: 'dashboard',
    media: 'text/event-stream',
  },
  'GET /v1/monitor/nodes': {
    summary: 'Sync nodes and their load',
    tag: 'Monitor',
    auth: 'dashboard',
    note: 'Self-hosted installations, owner or admin.',
  },
};

const SECURITY: Record<Auth, Record<string, string[]>[]> = {
  public: [],
  cookie: [{ refreshCookie: [] }],
  dashboard: [{ dashboardSession: [] }],
  secret: [{ secretKey: [] }],
  secretOrDashboard: [{ secretKey: [] }, { dashboardSession: [] }],
  client: [{ clientToken: [] }],
};

const ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'VALIDATION_FAILED',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'UNAVAILABLE',
  'INTERNAL',
];

const toSchema = (z: ZodTypeAny): Record<string, unknown> => {
  const rest = zodToJsonSchema(z as Parameters<typeof zodToJsonSchema>[0], {
    target: 'openApi3',
    $refStrategy: 'none',
  }) as Record<string, unknown>;
  delete rest.$schema;
  return rest;
};

/** Converts Fastify's `:param` to OpenAPI's `{param}` and collects the parameter names. */
const openapiPath = (p: string): { path: string; params: string[] } => {
  const params: string[] = [];
  return { path: p.replace(/:([A-Za-z]+)/g, (_, n: string) => (params.push(n), `{${n}}`)), params };
};

export function buildOpenApi(version = '1.0.0'): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [key, op] of Object.entries(OPERATIONS)) {
    const [method = '', route = ''] = key.split(' ');
    const { path, params } = openapiPath(route.replace(/^\/v1/, ''));
    const parameters: unknown[] = params.map((name) => ({
      name,
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));
    if (op.query) {
      const q = toSchema(op.query) as { properties?: Record<string, unknown>; required?: string[] };
      for (const [name, schema] of Object.entries(q.properties ?? {})) {
        parameters.push({
          name,
          in: 'query',
          required: q.required?.includes(name) ?? false,
          schema,
        });
      }
    }
    const desc = [op.note, op.auth === 'secretOrDashboard' ? KEY_NOTE : undefined]
      .filter(Boolean)
      .join(' ');
    (paths[path] ??= {})[method.toLowerCase()] = {
      summary: op.summary,
      ...(desc ? { description: desc } : {}),
      tags: [op.tag],
      operationId: `${method.toLowerCase()}_${path
        .replace(/[{}]/g, '')
        .replace(/[^A-Za-z0-9]+/g, '_')
        .replace(/^_|_$/g, '')}`,
      ...(parameters.length ? { parameters } : {}),
      ...(op.body
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: toSchema(op.body) } },
            },
          }
        : {}),
      security: SECURITY[op.auth],
      responses: {
        [String(op.ok ?? 200)]: {
          description: 'Success',
          ...((op.ok ?? 200) === 204
            ? {}
            : {
                content: {
                  [op.media ?? 'application/json']: {
                    schema: op.media ? { type: 'string', format: 'binary' } : { type: 'object' },
                  },
                },
              }),
        },
        default: {
          description: 'Error',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
      },
    };
  }
  return {
    openapi: '3.0.3',
    info: {
      title: 'Syncra REST API',
      version,
      description:
        'Self-hostable sync engine. This document covers the REST API; the WebSocket sync protocol is specified in docs/protocol.md.',
      license: { name: 'Apache-2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' },
    },
    servers: [{ url: 'http://localhost:8080/v1' }],
    tags: [...new Set(Object.values(OPERATIONS).map((o) => o.tag))].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        dashboardSession: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'Short-lived access token from login. Send X-Tenant-Id when the user belongs to several organizations.',
        },
        secretKey: {
          type: 'http',
          scheme: 'bearer',
          description: 'Secret API key `sk_...`. Server-side only.',
        },
        clientToken: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'End-user token from POST /tokens, signed with the tenant secret.',
        },
        refreshCookie: { type: 'apiKey', in: 'cookie', name: 'syncra_refresh' },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message', 'requestId'],
              properties: {
                code: { type: 'string', enum: ERROR_CODES },
                message: { type: 'string' },
                details: { type: 'object', additionalProperties: true },
                requestId: { type: 'string' },
              },
            },
          },
        },
      },
    },
  };
}
