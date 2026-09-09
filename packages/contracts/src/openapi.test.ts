import { describe, expect, it } from 'vitest';

import { buildOpenApiDocument } from './openapi';

const document = buildOpenApiDocument({ publicBaseUrl: 'http://localhost:8080' }) as {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
};

/** Every `$ref` in the document, wherever it appears. */
function references(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) {
      references(entry, found);
    }
    return found;
  }
  if (typeof value !== 'object' || value === null) {
    return found;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === '$ref' && typeof entry === 'string') {
      found.push(entry);
      continue;
    }
    references(entry, found);
  }

  return found;
}

const operations = Object.entries(document.paths).flatMap(([path, methods]) =>
  Object.entries(methods).map(([method, operation]) => ({
    name: `${method} ${path}`,
    operation: operation as Record<string, unknown>,
  })),
);

/**
 * The document is generated from the schemas that validate requests, so its
 * bodies cannot drift. Its shape can: the operation surface — parameters,
 * statuses, security — is written by hand, and a document that does not parse
 * is worse than none, because a client generator will produce something
 * plausible from it.
 */
describe('the OpenAPI document', () => {
  it('declares the version its dialect belongs to', () => {
    expect(document.openapi).toBe('3.1.0');
    expect(document.info.title.length).toBeGreaterThan(0);
    expect(document.info.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('resolves every reference it makes', () => {
    // A dangling $ref is the failure a hand-written surface produces most
    // often, and it breaks a generator rather than announcing itself.
    const defined = new Set(
      Object.keys(document.components.schemas).map((name) => `#/components/schemas/${name}`),
    );

    for (const reference of references(document)) {
      expect(defined.has(reference), reference).toBe(true);
    }
  });

  it('gives every operation an identifier a generator can name a method after', () => {
    for (const { name, operation } of operations) {
      expect(operation.operationId, name).toEqual(expect.any(String));
    }
  });

  it('gives every operation at least one documented response', () => {
    for (const { name, operation } of operations) {
      const responses = operation.responses as Record<string, unknown> | undefined;
      expect(Object.keys(responses ?? {}).length, name).toBeGreaterThan(0);
    }
  });

  it('uses only status codes it could actually return', () => {
    for (const { name, operation } of operations) {
      const statuses = Object.keys(operation.responses ?? {});

      for (const status of statuses) {
        expect(Number(status), `${name} -> ${status}`).toBeGreaterThanOrEqual(100);
        expect(Number(status), `${name} -> ${status}`).toBeLessThan(600);
      }
    }
  });

  it('names an authentication scheme for every operation that needs one', () => {
    expect(Object.keys(document.components.securitySchemes)).toContain('apiKey');

    for (const { name, operation } of operations) {
      // An operation opts out explicitly with `security: []`; nothing is
      // allowed to be silent about it.
      const isPublic = Array.isArray(operation.security) && operation.security.length === 0;
      const responses = operation.responses as Record<string, unknown>;

      if (!isPublic) {
        expect(Object.keys(responses), name).toContain('401');
      }
    }
  });

  it('documents the two surfaces a caller can reach, and nothing else', () => {
    for (const path of Object.keys(document.paths)) {
      expect(path.startsWith('/v1/') || path.startsWith('/webhooks/'), path).toBe(true);
    }
  });
});

/**
 * The statuses an operation lists are written by hand, and every one of these
 * was wrong: a 422 documented on a path that cannot produce it, a 409 and a 404
 * described as 422, a 400 raised by the path pipe on four operations and
 * mentioned on none, and a scope check whose 403 was documented only for the
 * two write operations. A client generator turns each of those into a branch
 * that never runs, or omits one that does.
 */
function statusesOf(name: string): string[] {
  const found = operations.find((entry) => entry.name === name);
  if (found === undefined) {
    throw new Error(`The document has no operation ${name}.`);
  }

  return Object.keys(found.operation.responses as Record<string, unknown>).toSorted(
    (first, second) => first.localeCompare(second),
  );
}

function describedBy(name: string, status: string): string {
  const found = operations.find((entry) => entry.name === name);
  const responses = found?.operation.responses as Record<string, { description: string }>;

  return responses[status]?.description ?? '';
}

describe('the statuses each operation documents', () => {
  it.each([
    ['get /v1/notifications', ['200', '400', '401', '403', '429']],
    ['post /v1/notifications', ['202', '400', '401', '403', '404', '409', '422', '429']],
    ['get /v1/notifications/{notificationId}', ['200', '400', '401', '403', '404', '429']],
    ['get /v1/notifications/{notificationId}/events', ['200', '400', '401', '403', '404', '429']],
    [
      'post /v1/notifications/{notificationId}/cancel',
      ['200', '400', '401', '403', '404', '409', '429'],
    ],
    ['get /v1/applications/current', ['200', '401', '403', '429']],
  ])('%s', (name, expected) => {
    expect(statusesOf(name)).toStrictEqual(expected);
  });

  it('attributes a missing connection to the conflict it is, not to 422', () => {
    expect(describedBy('post /v1/notifications', '409')).toContain('no connected WhatsApp session');
    expect(describedBy('post /v1/notifications', '422')).not.toContain('WhatsApp session');
  });

  it('attributes an invalid recipient to the 400 the validator actually returns', () => {
    expect(describedBy('post /v1/notifications', '400')).toContain('recipient');
    expect(describedBy('post /v1/notifications', '422')).not.toContain('recipient');
  });

  it('documents the identifier rejection every path parameter can produce', () => {
    for (const name of [
      'get /v1/notifications/{notificationId}',
      'get /v1/notifications/{notificationId}/events',
      'post /v1/notifications/{notificationId}/cancel',
    ]) {
      expect(describedBy(name, '400')).toContain('not a valid identifier');
    }
  });
});

describe('the problem document', () => {
  it('describes the fields a validation failure actually carries', () => {
    const problem = document.components.schemas.Problem as {
      properties: Record<string, unknown>;
      required: string[];
    };

    expect(Object.keys(problem.properties)).toContain('errors');
    expect(Object.keys(problem.properties)).toContain('correlationId');
    // Every problem this API emits sets it, and a client that has to guess
    // whether a reason is present will not show one.
    expect(problem.required).toContain('detail');
  });
});
