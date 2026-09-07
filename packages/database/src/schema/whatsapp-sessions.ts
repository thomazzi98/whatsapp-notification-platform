import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  index,
  integer,
  pgTable,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { applications } from './applications';
import { createdAtColumn, timestampColumn, updatedAtColumn } from './columns';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

export const whatsAppSessions = pgTable(
  'whatsapp_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull().default('WAHA'),
    // The provider's session namespace is global, so a duplicate name would
    // cross-wire two tenants onto one WhatsApp account. This is a security
    // constraint, not a convenience one.
    providerSessionName: text('provider_session_name').notNull(),
    displayName: text('display_name').notNull(),
    status: text('status').notNull().default('STOPPED'),
    phoneNumber: text('phone_number'),
    pushName: text('push_name'),
    // Encrypted rather than hashed: verifying an inbound signature needs the
    // original value back.
    webhookSigningKeyCiphertext: bytea('webhook_signing_key_ciphertext').notNull(),
    webhookSigningKeyVersion: smallint('webhook_signing_key_version').notNull().default(1),
    sendPacingMinimumSeconds: integer('send_pacing_minimum_seconds').notNull().default(30),
    sendPacingMaximumSeconds: integer('send_pacing_maximum_seconds').notNull().default(60),
    nextSendAllowedAt: timestampColumn('next_send_allowed_at').notNull().defaultNow(),
    lastStatusAt: timestampColumn('last_status_at').notNull().defaultNow(),
    lastError: text('last_error'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('whatsapp_sessions_provider_name_unique').on(
      table.provider,
      table.providerSessionName,
    ),
    // Composite target so a notification cannot reference a session belonging
    // to another application.
    unique('whatsapp_sessions_application_id_unique').on(table.applicationId, table.id),
    index('whatsapp_sessions_application_status_index').on(table.applicationId, table.status),
    check(
      'whatsapp_sessions_status_check',
      sql`${table.status} in ('STOPPED', 'STARTING', 'SCAN_QR_CODE', 'WORKING', 'FAILED', 'UNKNOWN')`,
    ),
    check(
      'whatsapp_sessions_pacing_range_check',
      sql`${table.sendPacingMaximumSeconds} >= ${table.sendPacingMinimumSeconds}`,
    ),
    check('whatsapp_sessions_pacing_minimum_check', sql`${table.sendPacingMinimumSeconds} >= 0`),
  ],
);
