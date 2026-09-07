import { sql } from 'drizzle-orm';
import { pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { createdAtColumn, updatedAtColumn } from './columns';

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    // Slugs appear in URLs and are compared case-insensitively; an expression
    // index keeps that lookup a seek rather than a scan.
    uniqueIndex('organizations_slug_unique').on(sql`lower(${table.slug})`),
  ],
);
