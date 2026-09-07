import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { createdAtColumn, timestampColumn, updatedAtColumn } from './columns';
import { organizations } from './organizations';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    // Argon2id encoded string. The parameters live inside the hash, so a
    // future parameter change does not invalidate existing credentials.
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    role: text('role').notNull().default('MEMBER'),
    status: text('status').notNull().default('ACTIVE'),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestampColumn('locked_until'),
    lastLoginAt: timestampColumn('last_login_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('users_email_unique').on(sql`lower(${table.email})`),
    index('users_organization_id_index').on(table.organizationId),
    check('users_role_check', sql`${table.role} in ('OWNER', 'ADMIN', 'MEMBER')`),
    check('users_status_check', sql`${table.status} in ('ACTIVE', 'DISABLED')`),
    check('users_failed_login_count_check', sql`${table.failedLoginCount} >= 0`),
  ],
);
