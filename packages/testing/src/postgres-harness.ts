import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';

import {
  applyMigrations,
  createDatabaseConnection,
  type DatabaseConnection,
} from '@platform/database';

export interface StartedTestDatabase {
  readonly connectionUrl: string;
  stop: () => Promise<void>;
}

/**
 * One container per test run, started in a global setup.
 *
 * A container per test file is what makes these suites unbearable on Docker
 * Desktop; isolation comes from truncating between tests instead.
 */
export async function startTestDatabase(migrationsFolder: string): Promise<StartedTestDatabase> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('notifications_test')
    .withUsername('platform_system')
    .withPassword('platform_system_password')
    .start();

  const connectionUrl = container.getConnectionUri();
  const connection = createDatabaseConnection({
    connectionUrl,
    maximumPoolSize: 2,
    applicationName: 'test-migrations',
  });

  try {
    await applyMigrations({
      database: connection.database,
      pool: connection.pool,
      migrationsFolder,
    });
  } finally {
    await connection.close();
  }

  return {
    connectionUrl,
    stop: async () => {
      await container.stop();
    },
  };
}

export interface TestDatabaseHandle {
  /** Empties every table so each test starts from a known state. */
  truncateAllTables: () => Promise<void>;
  /**
   * Creates the WhatsApp connection a notification needs, without going through
   * the provider. Pairing a real session requires a human with a phone.
   */
  insertWhatsAppSession: (
    applicationId: string,
    providerSessionName: string,
    options?: WhatsAppSessionFixtureOptions,
  ) => Promise<string>;
  /**
   * Creates an organization and an application directly.
   *
   * The API's own registration flow is the right fixture for tests that go
   * through HTTP; the worker has no HTTP surface, so it needs a tenant without
   * pulling the entire API into its dependency graph.
   */
  insertApplication: (options?: ApplicationFixtureOptions) => Promise<string>;
  insertNotification: (input: NotificationFixture) => Promise<string>;
  readNotification: (notificationId: string) => Promise<NotificationRow | undefined>;
  listEventTypes: (notificationId: string) => Promise<string[]>;
  listSendAttempts: (notificationId: string) => Promise<SendAttemptRow[]>;
  /** Simulates a worker that died between calling the provider and hearing back. */
  insertUnresolvedSendAttempt: (
    applicationId: string,
    notificationId: string,
    attemptNumber: number,
  ) => Promise<void>;
  /**
   * Backdates a claim so the reaper considers it abandoned. Waiting for the
   * real threshold would put minutes of sleeping into the suite.
   */
  ageClaim: (notificationId: string, ageSeconds: number) => Promise<void>;
  /** Dispatch jobs queued for one notification. */
  countDispatchJobs: (notificationId: string) => Promise<number>;
  countAllDispatchJobs: () => Promise<number>;
  close: () => Promise<void>;
}

export interface WhatsAppSessionFixtureOptions {
  readonly status?: string;
  readonly sendPacingMinimumSeconds?: number;
  readonly sendPacingMaximumSeconds?: number;
}

export interface ApplicationFixtureOptions {
  readonly unknownOutcomePolicy?: 'RETRY' | 'FAIL_CLOSED';
}

export interface NotificationFixture {
  readonly applicationId: string;
  readonly whatsAppSessionId: string;
  readonly status?: string;
  readonly recipient?: string;
  readonly body?: string;
  readonly maximumAttempts?: number;
  readonly attemptCount?: number;
  readonly scheduledAt?: Date;
  readonly nextAttemptAt?: Date;
  readonly createdAt?: Date;
}

export interface NotificationRow {
  readonly id: string;
  readonly status: string;
  readonly attemptCount: number;
  readonly providerMessageId: string | null;
  readonly recipientChatIdentifier: string | null;
  readonly failureCode: string | null;
  readonly failureClassification: string | null;
  readonly nextAttemptAt: Date | null;
  readonly sentAt: Date | null;
  readonly failedAt: Date | null;
  readonly claimToken: string | null;
}

export interface SendAttemptRow {
  readonly attemptNumber: number;
  readonly outcome: string | null;
  readonly providerMessageId: string | null;
  readonly failureCode: string | null;
}

/**
 * The driver hands raw queries their timestamps as strings; only drizzle's
 * typed query builder maps them to dates. Coercing here keeps that detail out
 * of every assertion that compares a scheduled time.
 */
function toDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value !== 'string') {
    return null;
  }
  return new Date(value);
}

/**
 * The only database access a test needs.
 *
 * Exposing this here is what keeps application test files from importing the
 * persistence adapter directly, which the layering rules forbid for good
 * reason: a test that can reach the database can also quietly depend on its
 * internals.
 */
export function connectToTestDatabase(connectionUrl: string): TestDatabaseHandle {
  const connection: DatabaseConnection = createDatabaseConnection({
    connectionUrl,
    maximumPoolSize: 2,
    applicationName: 'test-fixtures',
  });

  async function countJobs(condition: ReturnType<typeof sql> | undefined): Promise<number> {
    const result = await connection.database.execute<{ count: string }>(
      condition === undefined
        ? sql`select count(*)::text as count from pgboss.job where name = 'notification.dispatch'`
        : sql`select count(*)::text as count from pgboss.job
              where name = 'notification.dispatch' and ${condition}`,
    );

    return Number(result.rows[0]?.count ?? '0');
  }

  async function insertReturningId(
    statement: ReturnType<typeof sql>,
    what: string,
  ): Promise<string> {
    const result = await connection.database.execute<{ id: string }>(statement);
    const identifier = result.rows[0]?.id;

    if (identifier === undefined) {
      throw new Error(`Failed to insert the test ${what}.`);
    }
    return identifier;
  }

  // Unique per call, so fixtures never collide on the slug or session name
  // uniqueness constraints within one test file.
  let fixtureCounter = 0;
  const nextFixtureSuffix = (): string => {
    fixtureCounter += 1;
    return `${String(process.pid)}-${String(fixtureCounter)}`;
  };

  return {
    insertWhatsAppSession: async (applicationId, providerSessionName, options = {}) =>
      insertReturningId(
        sql`
        insert into whatsapp_sessions
          (application_id, provider_session_name, display_name,
           webhook_signing_key_ciphertext, status,
           send_pacing_minimum_seconds, send_pacing_maximum_seconds)
        values (${applicationId}, ${providerSessionName}, 'Test connection',
                decode('00', 'hex'), ${options.status ?? 'WORKING'},
                ${options.sendPacingMinimumSeconds ?? 30},
                ${options.sendPacingMaximumSeconds ?? 60})
        returning id
      `,
        'WhatsApp session',
      ),
    insertApplication: async (options = {}) => {
      const suffix = nextFixtureSuffix();
      const organizationId = await insertReturningId(
        sql`insert into organizations (name, slug)
            values (${`Fixture ${suffix}`}, ${`fixture-${suffix}`})
            returning id`,
        'organization',
      );

      return insertReturningId(
        sql`insert into applications (organization_id, name, slug, unknown_outcome_policy)
            values (${organizationId}, 'Fixture application', ${`app-${suffix}`},
                    ${options.unknownOutcomePolicy ?? 'RETRY'})
            returning id`,
        'application',
      );
    },
    insertNotification: async (input) =>
      insertReturningId(
        sql`
        insert into notifications
          (id, application_id, whatsapp_session_id, status, recipient_phone_number,
           rendered_body, maximum_attempts, attempt_count, scheduled_at, next_attempt_at,
           created_at)
        values (gen_random_uuid(), ${input.applicationId}, ${input.whatsAppSessionId},
                ${input.status ?? 'QUEUED'}, ${input.recipient ?? '+5511999990000'},
                ${input.body ?? 'Your order has shipped.'},
                ${input.maximumAttempts ?? 5}, ${input.attemptCount ?? 0},
                ${input.scheduledAt ?? null}, ${input.nextAttemptAt ?? null},
                ${input.createdAt ?? new Date()})
        returning id
      `,
        'notification',
      ),
    readNotification: async (notificationId) => {
      const result = await connection.database.execute<
        NotificationRow & Record<string, unknown>
      >(sql`
        select id, status, attempt_count as "attemptCount",
               provider_message_id as "providerMessageId",
               recipient_chat_identifier as "recipientChatIdentifier",
               failure_code as "failureCode",
               failure_classification as "failureClassification",
               next_attempt_at as "nextAttemptAt", sent_at as "sentAt",
               failed_at as "failedAt", claim_token as "claimToken"
        from notifications where id = ${notificationId}
      `);
      const row = result.rows[0];

      if (row === undefined) {
        return undefined;
      }
      return {
        ...row,
        attemptCount: Number(row.attemptCount),
        nextAttemptAt: toDate(row.nextAttemptAt),
        sentAt: toDate(row.sentAt),
        failedAt: toDate(row.failedAt),
      };
    },
    listEventTypes: async (notificationId) => {
      const result = await connection.database.execute<{ eventType: string }>(sql`
        select event_type as "eventType" from notification_events
        where notification_id = ${notificationId}
        order by occurred_at, id
      `);

      return result.rows.map((row) => row.eventType);
    },
    listSendAttempts: async (notificationId) => {
      const result = await connection.database.execute<
        SendAttemptRow & Record<string, unknown>
      >(sql`
        select attempt_number as "attemptNumber", outcome,
               provider_message_id as "providerMessageId", failure_code as "failureCode"
        from notification_send_attempts
        where notification_id = ${notificationId}
        order by attempt_number
      `);

      return result.rows;
    },
    insertUnresolvedSendAttempt: async (applicationId, notificationId, attemptNumber) => {
      await connection.database.execute(sql`
        insert into notification_send_attempts
          (id, application_id, notification_id, attempt_number, request_started_at)
        values (gen_random_uuid(), ${applicationId}, ${notificationId}, ${attemptNumber}, now())
      `);
    },
    ageClaim: async (notificationId, ageSeconds) => {
      await connection.database.execute(sql`
        update notifications
        set claim_token = gen_random_uuid(),
            claimed_at = now() - make_interval(secs => ${ageSeconds})
        where id = ${notificationId}
      `);
    },
    countDispatchJobs: async (notificationId) =>
      countJobs(sql`data->>'notificationId' = ${notificationId}`),
    countAllDispatchJobs: async () => countJobs(undefined),
    truncateAllTables: async () => {
      // Reference data seeded by a migration must survive: the notification
      // status foreign key points at it, so truncating it makes every insert
      // fail with a confusing constraint error.
      const result = await connection.database.execute<{ tablename: string }>(
        sql`select tablename from pg_tables
            where schemaname = 'public'
              and tablename not like '__drizzle%'
              and tablename not in ('notification_statuses', 'notification_status_transitions')`,
      );
      const tableNames = result.rows.map((row) => `"${row.tablename}"`);

      if (tableNames.length === 0) {
        return;
      }
      await connection.database.execute(
        sql.raw(`truncate table ${tableNames.join(', ')} restart identity cascade`),
      );
      // Jobs left behind would block the next send for the same key under the
      // dispatch queue's exclusive policy.
      await connection.database.execute(sql`delete from pgboss.job`);
    },
    close: async () => {
      await connection.close();
    },
  };
}
