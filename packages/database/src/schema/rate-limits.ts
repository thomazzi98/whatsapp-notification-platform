import { sql } from 'drizzle-orm';
import { check, pgTable, text } from 'drizzle-orm/pg-core';

import { timestampColumn } from './columns';

/**
 * One row per rate-limited subject, holding the single value the algorithm
 * needs: the theoretical time at which the next request would be exactly on
 * pace.
 *
 * There is deliberately no index but the primary key. Every request updates its
 * own row in place, and a secondary index would have to be updated too — which
 * is what turns a cheap heap-only update into a full index write on the hottest
 * table in the system.
 *
 * Nothing here is worth keeping: a row that has not been touched for longer
 * than its window carries no information, and the reaper deletes it.
 */
export const rateLimitBuckets = pgTable(
  'rate_limit_buckets',
  {
    /** The subject, namespaced by what is being limited. */
    subject: text('subject').primaryKey(),
    theoreticalArrivalAt: timestampColumn('theoretical_arrival_at').notNull(),
    updatedAt: timestampColumn('updated_at').notNull().defaultNow(),
  },
  (table) => [
    check(
      'rate_limit_buckets_subject_length_check',
      sql`length(${table.subject}) between 1 and 200`,
    ),
  ],
);
