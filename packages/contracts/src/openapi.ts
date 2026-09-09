import { notificationStatuses } from '@platform/domain';
import { z } from 'zod';

import {
  notificationCreationRequestSchema,
  notificationEventResponseSchema,
  notificationListResponseSchema,
  notificationResponseSchema,
} from './notifications';

/**
 * The description is generated from the same schemas that validate requests at
 * runtime, so it cannot describe a field the API does not accept. Zod 4 emits
 * JSON Schema 2020-12, which is the dialect OpenAPI 3.1 uses — no translation
 * layer, and no second definition of the same shape to keep in step.
 */
const JSON_SCHEMA_TARGET = 'draft-2020-12';

function toRequestSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: JSON_SCHEMA_TARGET, io: 'input' });
}

function toResponseSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: JSON_SCHEMA_TARGET, io: 'output' });
}

/** RFC 9457. Every error this API returns has this shape. */
const problemSchema = {
  type: 'object',
  properties: {
    type: { type: 'string', format: 'uri' },
    title: { type: 'string' },
    status: { type: 'integer' },
    detail: { type: 'string' },
    instance: { type: 'string' },
  },
  required: ['type', 'title', 'status'],
} as const;

const problemResponse = (description: string): Record<string, unknown> => ({
  description,
  content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } },
});

const notificationIdentifierParameter = {
  name: 'notificationId',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
} as const;

/**
 * Advertised on every metered response so a caller can pace itself rather than
 * discover the limit by being refused.
 */
const rateLimitHeaders = {
  'ratelimit-limit': { schema: { type: 'integer' }, description: 'Requests allowed per period.' },
  'ratelimit-remaining': { schema: { type: 'integer' }, description: 'Requests still available.' },
  'ratelimit-reset': {
    schema: { type: 'integer' },
    description: 'Seconds until the allowance is replenished.',
  },
} as const;

/**
 * The version of the described interface rather than of the build. It changes
 * when the contract changes, which is the only thing a client can act on.
 */
const API_VERSION = '1.0.0';

export interface OpenApiDocumentOptions {
  readonly publicBaseUrl: string;
}

export function buildOpenApiDocument(options: OpenApiDocumentOptions): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'WhatsApp Notification Platform',
      version: API_VERSION,
      description: [
        'Send WhatsApp notifications and follow what happens to them.',
        '',
        'Delivery is at-least-once. The provider behind this API accepts no',
        'idempotency key of its own, so a worker killed between the provider',
        'accepting a message and the outcome being committed leaves a window',
        'that cannot be closed from this side. Duplicate suppression is strong',
        'and the guarantee is stated honestly rather than overclaimed.',
        '',
        'Send an Idempotency-Key with every creation request. A repeated key',
        'with an identical body replays the original response; with a different',
        'body it is refused. Keys expire after twenty-four hours.',
      ].join('\n'),
    },
    servers: [{ url: options.publicBaseUrl }],
    tags: [
      { name: 'Notifications', description: 'Creating notifications and following their delivery' },
      { name: 'Applications', description: 'What the presented key is allowed to do' },
    ],
    components: {
      securitySchemes: {
        apiKey: {
          type: 'http',
          scheme: 'bearer',
          description: 'An API key issued in the dashboard, sent as `Bearer wnp_live_…`.',
        },
      },
      schemas: {
        Problem: problemSchema,
        NotificationStatus: toResponseSchema(z.enum(notificationStatuses)),
        NotificationCreationRequest: toRequestSchema(notificationCreationRequestSchema),
        Notification: toResponseSchema(notificationResponseSchema),
        NotificationList: toResponseSchema(notificationListResponseSchema),
        NotificationEvent: toResponseSchema(notificationEventResponseSchema),
      },
    },
    security: [{ apiKey: [] }],
    paths: {
      '/v1/notifications': {
        post: {
          tags: ['Notifications'],
          summary: 'Accept a notification for delivery',
          description:
            'Answers 202, not 200: the notification is persisted and queued, not delivered. ' +
            'Nothing on this path contacts WhatsApp, which is why it answers in milliseconds.',
          operationId: 'createNotification',
          parameters: [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: false,
              schema: { type: 'string', maxLength: 255 },
              description: 'Makes a retry safe. Scoped to the application, and valid for 24 hours.',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/NotificationCreationRequest' },
              },
            },
          },
          responses: {
            '202': {
              description: 'Accepted for delivery.',
              headers: {
                ...rateLimitHeaders,
                'idempotent-replayed': {
                  schema: { type: 'string', enum: ['true'] },
                  description: 'Present when this response replays an earlier identical request.',
                },
              },
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Notification' } },
              },
            },
            '400': problemResponse('The request body could not be parsed.'),
            '401': problemResponse('The API key is missing or not valid.'),
            '403': problemResponse('The API key lacks the notifications:write scope.'),
            '409': problemResponse('A request with this Idempotency-Key is still in flight.'),
            '422': problemResponse(
              'The request is well formed but cannot be acted on — an invalid recipient, ' +
                'a schedule in the past, no connected WhatsApp session, or an Idempotency-Key ' +
                'already used with a different body.',
            ),
            '429': problemResponse('The rate limit was exceeded. See retry-after.'),
          },
        },
        get: {
          tags: ['Notifications'],
          summary: 'List notifications',
          description:
            'Newest first, paginated by an opaque signed cursor. Pass the nextCursor from the ' +
            'previous page; a tampered cursor is rejected rather than executed.',
          operationId: 'listNotifications',
          parameters: [
            {
              name: 'status',
              in: 'query',
              required: false,
              description: 'Repeat the parameter to filter on several statuses.',
              schema: {
                oneOf: [
                  { $ref: '#/components/schemas/NotificationStatus' },
                  { type: 'array', items: { $ref: '#/components/schemas/NotificationStatus' } },
                ],
              },
            },
            { name: 'recipient', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
            },
          ],
          responses: {
            '200': {
              description: 'One page of notifications.',
              headers: rateLimitHeaders,
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/NotificationList' } },
              },
            },
            '401': problemResponse('The API key is missing or not valid.'),
            '422': problemResponse('The cursor or a filter is not valid.'),
            '429': problemResponse('The rate limit was exceeded. See retry-after.'),
          },
        },
      },
      '/v1/notifications/{notificationId}': {
        get: {
          tags: ['Notifications'],
          summary: 'Read one notification',
          operationId: 'getNotification',
          parameters: [notificationIdentifierParameter],
          responses: {
            '200': {
              description: 'The notification.',
              headers: rateLimitHeaders,
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Notification' } },
              },
            },
            '401': problemResponse('The API key is missing or not valid.'),
            '404': problemResponse(
              'No such notification for this application. A notification belonging to another ' +
                'tenant answers the same way, so the API cannot be used to discover identifiers.',
            ),
            '429': problemResponse('The rate limit was exceeded. See retry-after.'),
          },
        },
      },
      '/v1/notifications/{notificationId}/events': {
        get: {
          tags: ['Notifications'],
          summary: 'Read the delivery timeline',
          description:
            'Every state change, in order, including each attempt and the acknowledgements the ' +
            'provider reported. A missing read receipt is not a failure: recipients can turn ' +
            'read receipts off.',
          operationId: 'listNotificationEvents',
          parameters: [notificationIdentifierParameter],
          responses: {
            '200': {
              description: 'The timeline, oldest first.',
              headers: rateLimitHeaders,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      data: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/NotificationEvent' },
                      },
                    },
                    required: ['data'],
                  },
                },
              },
            },
            '401': problemResponse('The API key is missing or not valid.'),
            '404': problemResponse('No such notification for this application.'),
            '429': problemResponse('The rate limit was exceeded. See retry-after.'),
          },
        },
      },
      '/v1/notifications/{notificationId}/cancel': {
        post: {
          tags: ['Notifications'],
          summary: 'Cancel a notification that has not been handed to the provider',
          description:
            'A notification already being dispatched cannot be cancelled: the provider call may ' +
            'be in flight, and a sent WhatsApp message cannot be recalled.',
          operationId: 'cancelNotification',
          parameters: [notificationIdentifierParameter],
          responses: {
            '200': {
              description: 'Cancelled.',
              headers: rateLimitHeaders,
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Notification' } },
              },
            },
            '401': problemResponse('The API key is missing or not valid.'),
            '403': problemResponse('The API key lacks the notifications:write scope.'),
            '404': problemResponse('No such notification for this application.'),
            '409': problemResponse('The notification can no longer be cancelled.'),
            '429': problemResponse('The rate limit was exceeded. See retry-after.'),
          },
        },
      },
      '/v1/applications/current': {
        get: {
          tags: ['Applications'],
          summary: 'Describe the application this key belongs to',
          description:
            'Lets an integrator confirm which application a key belongs to and what it may do, ' +
            'without sending a real message to find out.',
          operationId: 'getCurrentApplication',
          responses: {
            '200': {
              description: 'The application and the scopes carried by this key.',
              headers: rateLimitHeaders,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'string', format: 'uuid' },
                      name: { type: 'string' },
                      slug: { type: 'string' },
                      status: { type: 'string' },
                      scopes: { type: 'array', items: { type: 'string' } },
                    },
                    required: ['id', 'name', 'slug', 'status', 'scopes'],
                  },
                },
              },
            },
            '401': problemResponse('The API key is missing or not valid.'),
            '429': problemResponse('The rate limit was exceeded. See retry-after.'),
          },
        },
      },
      '/webhooks/whatsapp/{whatsAppSessionId}': {
        post: {
          tags: ['Callbacks'],
          summary: 'Receive a provider callback',
          description:
            'Called by the WhatsApp provider, not by an integrator. Deliberately outside /v1: ' +
            'it is authenticated by a signature over the raw request body rather than by an API ' +
            'key, so mixing it into the public API would put a route with entirely different ' +
            'authentication behind the same guard. It answers 202 for anything it records, ' +
            'including a redelivery of an event already filed, because the provider retries ' +
            'whatever is not answered quickly.',
          operationId: 'receiveProviderCallback',
          security: [],
          parameters: [
            {
              name: 'whatsAppSessionId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
            {
              name: 'x-webhook-hmac',
              in: 'header',
              required: true,
              schema: { type: 'string' },
              description: 'HMAC-SHA512 over the exact bytes of the body, in lowercase hex.',
            },
            {
              name: 'x-webhook-timestamp',
              in: 'header',
              required: false,
              schema: { type: 'string' },
              description: 'Seconds since the epoch. Outside the tolerance window it is refused.',
            },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          responses: {
            '202': {
              description: 'Recorded. Says nothing about whether it could be applied.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { accepted: { type: 'boolean' } },
                    required: ['accepted'],
                  },
                },
              },
            },
            '400': { description: 'The callback arrived without a body.' },
            '401': { description: 'The signature did not verify, or the timestamp was stale.' },
          },
        },
      },
      '/v1/openapi.json': {
        get: {
          tags: ['Applications'],
          summary: 'This document',
          description: 'Unauthenticated: a description of the API is not a secret.',
          operationId: 'getOpenApiDocument',
          security: [],
          responses: { '200': { description: 'The OpenAPI document.' } },
        },
      },
    },
  };
}
