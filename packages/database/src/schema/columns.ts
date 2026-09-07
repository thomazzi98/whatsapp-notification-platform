import { timestamp, type PgTimestampBuilderInitial } from 'drizzle-orm/pg-core';

/**
 * Every timestamp is stored with a time zone. A notification platform reasons
 * about scheduling and delivery windows across regions, so a naive timestamp
 * would be a latent correctness bug.
 */
export function timestampColumn<Name extends string>(name: Name): PgTimestampBuilderInitial<Name> {
  return timestamp(name, { withTimezone: true, mode: 'date' });
}

export function createdAtColumn(): ReturnType<
  ReturnType<typeof timestampColumn<'created_at'>>['defaultNow']
> {
  return timestampColumn('created_at').notNull().defaultNow();
}

export function updatedAtColumn(): ReturnType<
  ReturnType<typeof timestampColumn<'updated_at'>>['defaultNow']
> {
  return timestampColumn('updated_at').notNull().defaultNow();
}
