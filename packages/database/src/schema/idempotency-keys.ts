import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { applications } from './applications';
import { createdAtColumn, timestampColumn } from './columns';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    requestMethod: text('request_method').notNull(),
    requestPath: text('request_path').notNull(),
    // A digest of the canonicalised body. Reusing a key with a different
    // payload is a client bug, and answering it with the first response would
    // hide that.
    requestFingerprint: bytea('request_fingerprint').notNull(),
    state: text('state').notNull(),
    lockToken: uuid('lock_token').notNull(),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body').$type<Record<string, unknown>>(),
    resourceId: uuid('resource_id'),
    createdAt: createdAtColumn(),
    completedAt: timestampColumn('completed_at'),
    expiresAt: timestampColumn('expires_at').notNull(),
  },
  (table) => [
    // Scoped per application, never globally: a global scope would let one
    // tenant's key collide with another's.
    uniqueIndex('idempotency_keys_application_key_unique').on(table.applicationId, table.key),
    index('idempotency_keys_expiry_index').on(table.expiresAt),
    // Takeover of claims abandoned by a crashed instance. Partial, so it stays
    // tiny even though the table holds a day of traffic.
    index('idempotency_keys_stale_in_flight_index')
      .on(table.createdAt)
      .where(sql`${table.state} = 'IN_FLIGHT'`),
    check('idempotency_keys_state_check', sql`${table.state} in ('IN_FLIGHT', 'COMPLETED')`),
    check('idempotency_keys_key_length_check', sql`length(${table.key}) between 1 and 255`),
  ],
);
