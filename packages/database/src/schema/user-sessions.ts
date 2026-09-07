import { sql } from 'drizzle-orm';
import { customType, index, inet, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { createdAtColumn, timestampColumn } from './columns';
import { users } from './users';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

export const userSessions = pgTable(
  'user_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // SHA-256 of an opaque 256-bit token. The token has no guessable structure,
    // so a slow password hash would add latency to every authenticated request
    // and buy nothing.
    tokenHash: bytea('token_hash').notNull(),
    absoluteExpiresAt: timestampColumn('absolute_expires_at').notNull(),
    idleExpiresAt: timestampColumn('idle_expires_at').notNull(),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    createdAt: createdAtColumn(),
    lastUsedAt: timestampColumn('last_used_at').notNull().defaultNow(),
    revokedAt: timestampColumn('revoked_at'),
  },
  (table) => [
    // Every authenticated dashboard request is exactly this lookup.
    uniqueIndex('user_sessions_token_hash_unique').on(table.tokenHash),
    // Partial, because revoked rows accumulate and dominate over time while
    // only live sessions are ever listed or signed out.
    index('user_sessions_active_by_user_index')
      .on(table.userId)
      .where(sql`${table.revokedAt} is null`),
    index('user_sessions_idle_expires_at_index')
      .on(table.idleExpiresAt)
      .where(sql`${table.revokedAt} is null`),
  ],
);
