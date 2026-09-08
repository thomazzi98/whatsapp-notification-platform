import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { createdAtColumn, timestampColumn, updatedAtColumn } from './columns';
import { organizations } from './organizations';

/**
 * The tenant boundary for everything an API key can reach: notifications,
 * templates, WhatsApp sessions and keys all hang off an application.
 */
export const applications = pgTable(
  'applications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    rateLimitPerMinute: integer('rate_limit_per_minute').notNull().default(60),
    rateLimitBurst: integer('rate_limit_burst').notNull().default(10),
    dailySendLimit: integer('daily_send_limit'),
    defaultMaximumAttempts: integer('default_maximum_attempts').notNull().default(5),
    /**
     * What to do when a send's outcome is genuinely unknown — a timeout, or a
     * connection dropped after the request was written. The provider offers no
     * idempotency key, so there is no answer that is safe in both directions:
     * resending risks a duplicate, failing risks losing a message that was
     * actually delivered. The tenant chooses which risk it prefers.
     */
    unknownOutcomePolicy: text('unknown_outcome_policy').notNull().default('RETRY'),
    archivedAt: timestampColumn('archived_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    // Unique within an organization, not globally: two customers may both have
    // an application called "production".
    uniqueIndex('applications_organization_slug_unique').on(table.organizationId, table.slug),
    index('applications_organization_id_index')
      .on(table.organizationId)
      .where(sql`${table.archivedAt} is null`),
    check('applications_status_check', sql`${table.status} in ('ACTIVE', 'SUSPENDED')`),
    check(
      'applications_rate_limit_per_minute_check',
      sql`${table.rateLimitPerMinute} between 1 and 6000`,
    ),
    check('applications_rate_limit_burst_check', sql`${table.rateLimitBurst} between 1 and 1000`),
    check(
      'applications_daily_send_limit_check',
      sql`${table.dailySendLimit} is null or ${table.dailySendLimit} > 0`,
    ),
    check(
      'applications_default_maximum_attempts_check',
      sql`${table.defaultMaximumAttempts} between 1 and 10`,
    ),
    check(
      'applications_unknown_outcome_policy_check',
      sql`${table.unknownOutcomePolicy} in ('RETRY', 'FAIL_CLOSED')`,
    ),
  ],
);
