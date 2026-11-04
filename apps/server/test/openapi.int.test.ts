/** DX-04: the published OpenAPI document must describe exactly the routes the server registers. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPERATIONS, buildOpenApi } from '../src/http/openapi.js';
import { startStack, type Stack } from './stack.js';

let st: Stack;
beforeAll(async () => {
  st = await startStack();
});
afterAll(async () => {
  await st.close();
});

describe('OpenAPI document (DX-04)', () => {
  it('documents every /v1 route and nothing that does not exist', () => {
    const live = st.node.app.routeTable.filter((r) => r.split(' ')[1]?.startsWith('/v1/'));
    const documented = Object.keys(OPERATIONS);
    expect(
      live.filter((r) => !documented.includes(r)),
      'routes missing from OPERATIONS',
    ).toEqual([]);
    expect(
      documented.filter((r) => !live.includes(r)),
      'documented routes that do not exist',
    ).toEqual([]);
  });

  it('is structurally valid OpenAPI 3: every operation has security, responses, and resolvable refs', () => {
    const doc = buildOpenApi() as {
      openapi: string;
      paths: Record<
        string,
        Record<
          string,
          {
            operationId: string;
            responses: Record<string, unknown>;
            security: unknown[];
            parameters?: { name: string; in: string }[];
          }
        >
      >;
      components: { securitySchemes: Record<string, unknown>; schemas: Record<string, unknown> };
    };
    expect(doc.openapi).toMatch(/^3\.0\./);
    const ids = new Set<string>();
    let ops = 0;
    for (const [path, methods] of Object.entries(doc.paths)) {
      const pathParams = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      for (const [method, op] of Object.entries(methods)) {
        ops++;
        expect(['get', 'post', 'patch', 'delete'], `${method} ${path}`).toContain(method);
        expect(ids.has(op.operationId), `duplicate operationId ${op.operationId}`).toBe(false);
        ids.add(op.operationId);
        expect(Object.keys(op.responses).length, `${method} ${path}`).toBeGreaterThan(1);
        const declared = (op.parameters ?? []).filter((p) => p.in === 'path').map((p) => p.name);
        expect(declared.sort(), `${method} ${path} path parameters`).toEqual(
          [...pathParams].sort(),
        );
        for (const sec of op.security)
          for (const name of Object.keys(sec as object))
            expect(doc.components.securitySchemes, name).toHaveProperty(name);
      }
    }
    expect(ops).toBe(Object.keys(OPERATIONS).length);
    expect(JSON.stringify(doc)).not.toMatch(/"\$ref":"#\/(?!components\/schemas\/Error)/);
  });

  it('passes an independent OpenAPI 3 validator (swagger-parser), including the shipped file', async () => {
    const SwaggerParser = (await import('@apidevtools/swagger-parser')).default;
    await expect(
      SwaggerParser.validate(JSON.parse(JSON.stringify(buildOpenApi()))),
    ).resolves.toBeTruthy();
    const { fileURLToPath } = await import('node:url');
    await expect(
      SwaggerParser.validate(fileURLToPath(new URL('../../../docs/openapi.yaml', import.meta.url))),
    ).resolves.toBeTruthy();
  });

  it('request bodies come from the schemas the routes validate with', () => {
    const doc = buildOpenApi() as {
      paths: Record<
        string,
        Record<
          string,
          {
            requestBody?: {
              content: {
                'application/json': {
                  schema: {
                    required?: string[];
                    properties?: Record<string, { maxLength?: number; minLength?: number }>;
                  };
                };
              };
            };
          }
        >
      >;
    };
    const signup = doc.paths['/auth/signup']?.post?.requestBody?.content['application/json'].schema;
    expect(signup?.required).toEqual(
      expect.arrayContaining(['email', 'password', 'name', 'tenantName']),
    );
    expect(signup?.properties?.password?.minLength).toBe(10);
    const mint = doc.paths['/tokens']?.post?.requestBody?.content['application/json'].schema;
    expect(mint?.required).toEqual(expect.arrayContaining(['userId', 'access']));
  });

  it('is what the shipped docs/openapi.yaml was generated from (no drift)', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { parse } = await import('yaml');
    const file = fileURLToPath(new URL('../../../docs/openapi.yaml', import.meta.url));
    expect(
      parse(readFileSync(file, 'utf8')),
      'run: pnpm --filter @syncra/server gen:openapi',
    ).toEqual(JSON.parse(JSON.stringify(buildOpenApi())));
  });
});
