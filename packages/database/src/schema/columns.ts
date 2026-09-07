import { type PgTimestampBuilderInitial, timestamp } from 'drizzle-orm/pg-core';

/**
 * Every timestamp is stored with a time zone. A notification platform reasons
 * about scheduling and delivery windows across regions, so a naive timestamp
 * would be a latent correctness bug.
 */
export function timestampColumn<Name extends string>(name: Name): PgTimestampBuilderInitial<Name> {
  return timestamp(name, { withTimezone: true, mode: 'date' });
}

// The return types are derived from these builders rather than written out.
// Spelling them by hand loses the `.notNull()` refinement, which makes every
// row type nullable and forces casts throughout the repositories.
/* eslint-disable @typescript-eslint/explicit-function-return-type -- The type
   is exactly what is being inferred; writing it out is what loses .notNull(). */
const buildCreatedAt = () => timestampColumn('created_at').notNull().defaultNow();
const buildUpdatedAt = () => timestampColumn('updated_at').notNull().defaultNow();
/* eslint-enable @typescript-eslint/explicit-function-return-type */

export function createdAtColumn(): ReturnType<typeof buildCreatedAt> {
  return buildCreatedAt();
}

export function updatedAtColumn(): ReturnType<typeof buildUpdatedAt> {
  return buildUpdatedAt();
}
