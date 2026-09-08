import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { applications } from './applications';
import { createdAtColumn, timestampColumn, updatedAtColumn } from './columns';
import { templates } from './templates';
import { whatsAppSessions } from './whatsapp-sessions';

/**
 * The lookup table the status trigger reads. Keeping the legal transitions in
 * the database means no code path — not a migration, not a data fix run by
 * hand in psql — can move a notification into a state the domain forbids.
 */
export const notificationStatusTable = pgTable('notification_statuses', {
  status: text('status').primaryKey(),
});

export const notificationStatusTransitions = pgTable(
  'notification_status_transitions',
  {
    fromStatus: text('from_status')
      .notNull()
      .references(() => notificationStatusTable.status),
    toStatus: text('to_status')
      .notNull()
      .references(() => notificationStatusTable.status),
  },
  (table) => [primaryKey({ columns: [table.fromStatus, table.toStatus] })],
);

export const notifications = pgTable(
  'notifications',
  {
    // UUIDv7, generated in process. Time-ordered keys keep inserts appending at
    // the right edge of the index rather than scattering across it, which
    // matters most on the two hot tables.
    id: uuid('id').primaryKey(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    whatsAppSessionId: uuid('whatsapp_session_id').notNull(),
    templateId: uuid('template_id'),
    status: text('status')
      .notNull()
      .references(() => notificationStatusTable.status),
    recipientPhoneNumber: text('recipient_phone_number').notNull(),
    // Resolved by the provider rather than built locally, because national
    // numbering rules make a constructed identifier unreliable.
    recipientChatIdentifier: text('recipient_chat_identifier'),
    renderedBody: text('rendered_body').notNull(),
    templateVariables: jsonb('template_variables').$type<Record<string, string>>(),
    priority: smallint('priority').notNull().default(0),
    scheduledAt: timestampColumn('scheduled_at'),
    attemptCount: integer('attempt_count').notNull().default(0),
    maximumAttempts: integer('maximum_attempts').notNull().default(5),
    nextAttemptAt: timestampColumn('next_attempt_at'),
    // Set when a worker claims the row, so a crashed attempt can be recognised.
    claimToken: uuid('claim_token'),
    claimedAt: timestampColumn('claimed_at'),
    providerMessageId: text('provider_message_id'),
    providerAcknowledgement: smallint('provider_acknowledgement').notNull().default(0),
    sentAt: timestampColumn('sent_at'),
    deliveredAt: timestampColumn('delivered_at'),
    readAt: timestampColumn('read_at'),
    failedAt: timestampColumn('failed_at'),
    cancelledAt: timestampColumn('cancelled_at'),
    deadLetteredAt: timestampColumn('dead_lettered_at'),
    failureCode: text('failure_code'),
    failureReason: text('failure_reason'),
    failureClassification: text('failure_classification'),
    // A retry creates a new row pointing back here, because a failed
    // notification is terminal and its history must not be rewritten.
    retryOfNotificationId: uuid('retry_of_notification_id'),
    idempotencyKeyId: uuid('idempotency_key_id'),
    correlationId: text('correlation_id'),
    metadata: jsonb('metadata').$type<Record<string, string>>().notNull().default({}),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    // Composite target for the events and attempts tables, and the tenant
    // scoped point lookup.
    unique('notifications_application_id_unique').on(table.applicationId, table.id),

    // The tenant column leads because it is always an equality predicate;
    // leading with the range column would turn the equality into a filter.
    index('notifications_application_created_at_index').on(
      table.applicationId,
      table.createdAt,
      table.id,
    ),
    index('notifications_application_status_created_at_index').on(
      table.applicationId,
      table.status,
      table.createdAt,
    ),
    index('notifications_application_recipient_index').on(
      table.applicationId,
      table.recipientPhoneNumber,
      table.createdAt,
    ),

    // Resolves an inbound acknowledgement to its notification in one seek, and
    // is the last guard against two rows claiming the same sent message.
    uniqueIndex('notifications_provider_message_id_unique')
      .on(table.whatsAppSessionId, table.providerMessageId)
      .where(sql`${table.providerMessageId} is not null`),

    // Partial: each contains only work that is actually pending, so the
    // reconciler's cost is proportional to the backlog rather than to history.
    index('notifications_due_scheduled_index')
      .on(table.scheduledAt)
      .where(sql`${table.status} = 'SCHEDULED'`),
    index('notifications_due_retry_index')
      .on(table.nextAttemptAt)
      .where(sql`${table.status} = 'RETRYING'`),
    index('notifications_stuck_claims_index')
      .on(table.claimedAt)
      .where(sql`${table.status} = 'PROCESSING'`),
    index('notifications_template_usage_index')
      .on(table.templateId)
      .where(sql`${table.templateId} is not null`),

    // Cross-tenant references are made structurally impossible rather than
    // checked in application code.
    foreignKey({
      name: 'notifications_session_fkey',
      columns: [table.applicationId, table.whatsAppSessionId],
      foreignColumns: [whatsAppSessions.applicationId, whatsAppSessions.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'notifications_template_fkey',
      columns: [table.applicationId, table.templateId],
      foreignColumns: [templates.applicationId, templates.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'notifications_retry_of_fkey',
      columns: [table.retryOfNotificationId],
      foreignColumns: [table.id],
    }).onDelete('set null'),

    check(
      'notifications_scheduled_requires_time_check',
      sql`${table.status} <> 'SCHEDULED' or ${table.scheduledAt} is not null`,
    ),
    check(
      'notifications_retrying_requires_next_attempt_check',
      sql`${table.status} <> 'RETRYING' or ${table.nextAttemptAt} is not null`,
    ),
    check(
      'notifications_sent_requires_message_id_check',
      sql`${table.status} not in ('SENT', 'DELIVERED') or ${table.providerMessageId} is not null`,
    ),
    check('notifications_attempt_count_check', sql`${table.attemptCount} >= 0`),
    check('notifications_maximum_attempts_check', sql`${table.maximumAttempts} between 1 and 10`),
    check(
      'notifications_acknowledgement_check',
      sql`${table.providerAcknowledgement} between -1 and 4`,
    ),
    check('notifications_body_length_check', sql`length(${table.renderedBody}) between 1 and 4096`),
    check(
      'notifications_failure_classification_check',
      sql`${table.failureClassification} is null or ${table.failureClassification} in ('RETRYABLE', 'PERMANENT')`,
    ),
  ],
);

export const notificationEvents = pgTable(
  'notification_events',
  {
    id: uuid('id').primaryKey(),
    applicationId: uuid('application_id').notNull(),
    notificationId: uuid('notification_id').notNull(),
    eventType: text('event_type').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status'),
    attemptNumber: integer('attempt_number'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    correlationId: text('correlation_id'),
    occurredAt: timestampColumn('occurred_at').notNull().defaultNow(),
  },
  (table) => [
    // The only read pattern this table has. The identifier breaks ties when two
    // events share a millisecond.
    index('notification_events_timeline_index').on(
      table.notificationId,
      table.occurredAt,
      table.id,
    ),
    index('notification_events_activity_feed_index').on(table.applicationId, table.occurredAt),
    foreignKey({
      name: 'notification_events_notification_fkey',
      columns: [table.applicationId, table.notificationId],
      foreignColumns: [notifications.applicationId, notifications.id],
    }).onDelete('cascade'),
  ],
);

/**
 * The ledger of provider calls.
 *
 * Its reason for existing is the row with no outcome: an attempt is written and
 * committed before the network call, so a worker that dies mid-send leaves
 * durable evidence that a request may have reached WhatsApp. Without it a crash
 * is indistinguishable from a send that never happened, and the platform would
 * have to guess whether resending duplicates a delivered message.
 */
export const notificationSendAttempts = pgTable(
  'notification_send_attempts',
  {
    id: uuid('id').primaryKey(),
    applicationId: uuid('application_id').notNull(),
    notificationId: uuid('notification_id').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    requestStartedAt: timestampColumn('request_started_at').notNull().defaultNow(),
    requestFinishedAt: timestampColumn('request_finished_at'),
    outcome: text('outcome'),
    providerMessageId: text('provider_message_id'),
    failureCode: text('failure_code'),
  },
  (table) => [
    // Makes recording an attempt idempotent under a job redelivery: the second
    // insert fails rather than creating a phantom attempt.
    uniqueIndex('notification_send_attempts_unique').on(table.notificationId, table.attemptNumber),
    // Finds attempts whose outcome was never written because the process died.
    // Normally empty; this is the crash recovery index.
    index('notification_send_attempts_unresolved_index')
      .on(table.notificationId)
      .where(sql`${table.outcome} is null`),
    foreignKey({
      name: 'notification_send_attempts_notification_fkey',
      columns: [table.applicationId, table.notificationId],
      foreignColumns: [notifications.applicationId, notifications.id],
    }).onDelete('cascade'),
    check('notification_send_attempts_attempt_number_check', sql`${table.attemptNumber} >= 1`),
    check(
      'notification_send_attempts_outcome_check',
      sql`${table.outcome} is null or ${table.outcome} in ('SUCCEEDED', 'FAILED', 'UNKNOWN')`,
    ),
    check(
      'notification_send_attempts_resolution_check',
      sql`(${table.outcome} is null) = (${table.requestFinishedAt} is null)`,
    ),
  ],
);
