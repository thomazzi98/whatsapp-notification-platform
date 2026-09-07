import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { applications } from './applications';
import { createdAtColumn, updatedAtColumn } from './columns';
import { users } from './users';

export interface TemplateVariableDefinition {
  readonly name: string;
  readonly required: boolean;
  readonly defaultValue?: string;
  readonly description?: string;
}

export const templates = pgTable(
  'templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    version: integer('version').notNull().default(1),
    name: text('name').notNull(),
    body: text('body').notNull(),
    variables: jsonb('variables').$type<TemplateVariableDefinition[]>().notNull().default([]),
    status: text('status').notNull().default('DRAFT'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    // A template version is immutable once written; editing inserts the next
    // version, so a notification always records exactly what was sent.
    uniqueIndex('templates_application_key_version_unique').on(
      table.applicationId,
      table.key,
      table.version,
    ),
    // Partial unique: at most one active version per key, while any number of
    // archived versions coexist. A plain unique index here would be wrong.
    uniqueIndex('templates_active_version_unique')
      .on(table.applicationId, table.key)
      .where(sql`${table.status} = 'ACTIVE'`),
    unique('templates_application_id_unique').on(table.applicationId, table.id),
    index('templates_application_updated_at_index').on(table.applicationId, table.updatedAt),
    check('templates_key_check', sql`${table.key} ~ '^[a-z][a-z0-9_-]{0,63}$'`),
    check('templates_version_check', sql`${table.version} >= 1`),
    check('templates_body_length_check', sql`length(${table.body}) between 1 and 4096`),
    check('templates_status_check', sql`${table.status} in ('DRAFT', 'ACTIVE', 'ARCHIVED')`),
  ],
);
