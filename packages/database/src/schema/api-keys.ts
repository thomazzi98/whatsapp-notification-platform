import { sql } from 'drizzle-orm';
import { check, customType, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { applications } from './applications';
import { createdAtColumn, timestampColumn } from './columns';
import { users } from './users';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // The public half of the token. Indexing it is what makes authentication a
    // single seek, which in turn is why a keyed hash rather than a per-row
    // salted hash is the right choice for the secret half.
    keyIdentifier: text('key_identifier').notNull(),
    keyPrefix: text('key_prefix').notNull(),
    // HMAC-SHA256 of the secret under a pepper held outside the database, so a
    // database dump alone cannot be used to forge a key.
    keyHash: bytea('key_hash').notNull(),
    lastFour: text('last_four').notNull(),
    scopes: text('scopes').array().notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    expiresAt: timestampColumn('expires_at'),
    lastUsedAt: timestampColumn('last_used_at'),
    revokedAt: timestampColumn('revoked_at'),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex('api_keys_key_identifier_unique').on(table.keyIdentifier),
    uniqueIndex('api_keys_key_hash_unique').on(table.keyHash),
    index('api_keys_active_by_application_index')
      .on(table.applicationId)
      .where(sql`${table.revokedAt} is null`),
    check('api_keys_last_four_check', sql`length(${table.lastFour}) = 4`),
    // cardinality() returns 0 for an empty array, where array_length()
    // returns NULL — and a CHECK constraint passes on NULL, so the obvious
    // spelling of this rule would not reject an empty scope list.
    check('api_keys_scopes_not_empty_check', sql`cardinality(${table.scopes}) >= 1`),
  ],
);
