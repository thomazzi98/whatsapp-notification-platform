import { createTestConfiguration } from '@platform/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { ApiModule } from '../api.module';

interface RegisteredRoute {
  readonly method: string;
  readonly url: string;
}

let application: NestFastifyApplication;
let document: Record<string, never>;
const registeredRoutes: RegisteredRoute[] = [];

beforeAll(async () => {
  const configuration = createTestConfiguration(inject('databaseUrl'));

  const moduleReference = await Test.createTestingModule({
    imports: [ApiModule.forConfiguration(configuration)],
  }).compile();

  const adapter = new FastifyAdapter();
  // Registration is the only moment a Fastify route is enumerable, so the hook
  // has to be in place before the application is initialised.
  adapter.getInstance().addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      registeredRoutes.push({ method: method.toLowerCase(), url: route.url });
    }
  });

  application = moduleReference.createNestApplication<NestFastifyApplication>(adapter);
  await application.init();
  await application.getHttpAdapter().getInstance().ready();

  const response = await application.inject({ method: 'GET', url: '/v1/openapi.json' });
  document = JSON.parse(response.body) as Record<string, never>;
}, 180_000);

afterAll(async () => {
  await application.close();
});

/** Fastify writes `:name`; OpenAPI writes `{name}`. */
function toOpenApiPath(url: string): string {
  return url.replaceAll(/:(\w+)/g, '{$1}');
}

function documentedOperations(): Set<string> {
  const paths = document.paths as unknown as Record<string, Record<string, unknown>>;

  return new Set(
    Object.entries(paths).flatMap(([path, operations]) =>
      Object.keys(operations).map((method) => `${method} ${path}`),
    ),
  );
}

describe('the published description of the API', () => {
  it('is served without a key, because it is not a secret', async () => {
    const response = await application.inject({ method: 'GET', url: '/v1/openapi.json' });

    expect(response.statusCode).toBe(200);
    expect(document.openapi).toBe('3.1.0');
  });

  it('describes every public route the application actually serves', () => {
    // The drift that matters: a route shipped without being described. The
    // dashboard surface is deliberately absent — it is not a public contract.
    const undocumented = registeredRoutes
      // Fastify answers HEAD for every GET on its own. That is transport
      // behaviour rather than contract, and describing it would be noise.
      .filter((route) => route.method !== 'head' && route.url.startsWith('/v1/'))
      .map((route) => `${route.method} ${toOpenApiPath(route.url)}`)
      .filter((operation) => !documentedOperations().has(operation));

    expect(undocumented).toEqual([]);
  });

  it('describes no route the application does not serve', () => {
    const served = new Set(
      registeredRoutes.map((route) => `${route.method} ${toOpenApiPath(route.url)}`),
    );

    expect([...documentedOperations()].filter((operation) => !served.has(operation))).toEqual([]);
  });

  it('derives its request schema from the one that validates the request', () => {
    const components = document.components as unknown as {
      schemas: Record<
        string,
        { properties: Record<string, unknown>; required: string[] } | undefined
      >;
    };
    const creation = components.schemas.NotificationCreationRequest ?? {
      properties: {},
      required: [],
    };

    // Not an assertion about wording: these are the fields the pipe rejects a
    // request for missing, and a description that disagreed would send an
    // integrator down a path the API refuses.
    expect(creation.required).toEqual(['recipient', 'body']);
    expect(Object.keys(creation.properties)).toContain('scheduledAt');
  });
});
