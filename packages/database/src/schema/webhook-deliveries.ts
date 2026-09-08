import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { timestampColumn } from './columns';
import { whatsAppSessions } from './whatsapp-sessions';

/**
 * The inbox for provider callbacks.
 *
 * Everything that arrives is written here and answered immediately; the work of
 * acting on it happens in the worker. That split is what keeps the endpoint
 * fast enough that the provider does not time out and retry, and it means a
 * callback survives a crash between receiving it and understanding it.
 *
 * The provider's own event identifier is the deduplication key. Providers
 * redeliver on any non-2xx and sometimes on a slow 2xx, so the same
 * acknowledgement arriving twice must be a no-op rather than a second timeline
 * entry.
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey(),
    applicationId: uuid('application_id').notNull(),
    whatsAppSessionId: uuid('whatsapp_session_id').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    eventType: text('event_type').notNull(),
    providerSessionName: text('provider_session_name').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    receivedAt: timestampColumn('received_at').notNull().defaultNow(),
    processedAt: timestampColumn('processed_at'),
    processingAttempts: integer('processing_attempts').notNull().default(0),
    outcome: text('outcome'),
    outcomeDetail: text('outcome_detail'),
  },
  (table) => [
    // Scoped to the session, not global: two tenants' providers are free to
    // generate the same identifier, and a collision must not silently discard
    // one of their delivery receipts.
    uniqueIndex('webhook_deliveries_provider_event_unique').on(
      table.whatsAppSessionId,
      table.providerEventId,
    ),
    // Partial, because in a healthy system this is empty: it exists to find the
    // callbacks the worker has not yet dealt with.
    index('webhook_deliveries_unprocessed_index')
      .on(table.receivedAt)
      .where(sql`${table.processedAt} is null`),
    index('webhook_deliveries_application_received_index').on(
      table.applicationId,
      table.receivedAt,
    ),
    foreignKey({
      name: 'webhook_deliveries_session_fkey',
      columns: [table.applicationId, table.whatsAppSessionId],
      foreignColumns: [whatsAppSessions.applicationId, whatsAppSessions.id],
    }).onDelete('cascade'),
    check(
      'webhook_deliveries_outcome_check',
      sql`${table.outcome} is null or ${table.outcome} in ('APPLIED', 'IGNORED', 'UNMATCHED')`,
    ),
    check(
      'webhook_deliveries_resolution_check',
      sql`(${table.outcome} is null) = (${table.processedAt} is null)`,
    ),
  ],
);
