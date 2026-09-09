import {
  canTransitionNotificationStatus,
  type NotificationStatus,
  notificationStatuses,
} from '@platform/domain';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { applyMigrations } from './bootstrap';
import { createDatabaseConnection, type DatabaseConnection } from './connection';

let connection: DatabaseConnection;
let applicationId: string;
let sessionId: string;

beforeAll(async () => {
  connection = createDatabaseConnection({
    connectionUrl: inject('databaseUrl'),
    maximumPoolSize: 4,
    applicationName: 'status-guard-test',
  });

  await applyMigrations({
    database: connection.database,
    pool: connection.pool,
    migrationsFolder: './migrations',
  });

  const suffix = Date.now().toString(36);
  const organization = await connection.database.execute<{ id: string }>(sql`
    insert into organizations (name, slug) values ('Guard', ${`guard-${suffix}`}) returning id
  `);
  const organizationId = organization.rows[0]?.id ?? '';

  const application = await connection.database.execute<{ id: string }>(sql`
    insert into applications (organization_id, name, slug)
    values (${organizationId}, 'Guard', ${`guard-${suffix}`}) returning id
  `);
  applicationId = application.rows[0]?.id ?? '';

  const session = await connection.database.execute<{ id: string }>(sql`
    insert into whatsapp_sessions
      (application_id, provider_session_name, display_name, webhook_signing_key_ciphertext)
    values (${applicationId}, ${`guard-${suffix}`}, 'Guard', decode('00', 'hex'))
    returning id
  `);
  sessionId = session.rows[0]?.id ?? '';
}, 180_000);

afterAll(async () => {
  await connection.close();
});

let notificationCounter = 0;

async function createNotification(status: NotificationStatus): Promise<string> {
  notificationCounter += 1;
  const identifier = `00000000-0000-7000-8000-${String(notificationCounter).padStart(12, '0')}`;
  const scheduledAt = status === 'SCHEDULED' ? sql`now()` : sql`null`;
  const nextAttemptAt = status === 'RETRYING' ? sql`now()` : sql`null`;
  const providerMessageId =
    status === 'SENT' || status === 'DELIVERED' ? sql`${`message-${identifier}`}` : sql`null`;

  await connection.database.execute(sql`
    insert into notifications
      (id, application_id, whatsapp_session_id, status, recipient_phone_number,
       rendered_body, scheduled_at, next_attempt_at, provider_message_id)
    values (${identifier}, ${applicationId}, ${sessionId}, ${status}, '+5511999998888',
            'Hello', ${scheduledAt}, ${nextAttemptAt}, ${providerMessageId})
  `);

  return identifier;
}

interface PostgresErrorCause {
  readonly constraint?: string;
  readonly message?: string;
}

async function attemptTransition(
  notificationId: string,
  target: NotificationStatus,
): Promise<{ readonly accepted: boolean; readonly constraint?: string }> {
  const nextAttemptAt = target === 'RETRYING' ? sql`now()` : sql`next_attempt_at`;
  const providerMessageId =
    target === 'SENT' || target === 'DELIVERED'
      ? sql`coalesce(provider_message_id, ${`message-${notificationId}`})`
      : sql`provider_message_id`;

  try {
    await connection.database.execute(sql`
      update notifications
         set status = ${target},
             next_attempt_at = ${nextAttemptAt},
             provider_message_id = ${providerMessageId}
       where id = ${notificationId}
    `);
    return { accepted: true };
  } catch (error: unknown) {
    const cause = (error as { cause?: PostgresErrorCause }).cause;
    return { accepted: false, constraint: cause?.constraint };
  }
}

describe('notification status transitions in the database', () => {
  it('matches the transition table the domain declares', async () => {
    const result = await connection.database.execute<{
      from_status: string;
      to_status: string;
    }>(sql`select from_status, to_status from notification_status_transitions`);

    const inDatabase = new Set(result.rows.map((row) => `${row.from_status}->${row.to_status}`));
    const inDomain = new Set(
      notificationStatuses.flatMap((from) =>
        notificationStatuses
          .filter((to) => canTransitionNotificationStatus(from, to))
          .map((to) => `${from}->${to}`),
      ),
    );

    // The seam where the trigger and the code could silently diverge.
    expect([...inDatabase].toSorted((left, right) => left.localeCompare(right))).toEqual(
      [...inDomain].toSorted((left, right) => left.localeCompare(right)),
    );
  });

  it('knows every status the domain declares', async () => {
    const result = await connection.database.execute<{ status: string }>(
      sql`select status from notification_statuses`,
    );

    expect(new Set(result.rows.map((row) => row.status))).toEqual(new Set(notificationStatuses));
  });

  it('accepts a legal transition', async () => {
    const notificationId = await createNotification('QUEUED');

    await expect(attemptTransition(notificationId, 'PROCESSING')).resolves.toMatchObject({
      accepted: true,
    });
  });

  it('rejects moving a delivered notification back into the pipeline', async () => {
    const notificationId = await createNotification('DELIVERED');

    const result = await attemptTransition(notificationId, 'QUEUED');

    expect(result.accepted).toBe(false);
  });

  it('rejects reviving a failed notification, so history is never rewritten', async () => {
    const notificationId = await createNotification('FAILED');

    const result = await attemptTransition(notificationId, 'QUEUED');

    expect(result.accepted).toBe(false);
  });

  it('rejects cancelling a notification that is already being dispatched', async () => {
    // A provider call may be in flight and a sent message cannot be revoked.
    const notificationId = await createNotification('PROCESSING');

    const result = await attemptTransition(notificationId, 'CANCELLED');

    expect(result.accepted).toBe(false);
  });

  it('allows an update that does not touch the status', async () => {
    const notificationId = await createNotification('SENT');

    await connection.database.execute(sql`
      update notifications set provider_acknowledgement = 3, read_at = now()
       where id = ${notificationId}
    `);

    const result = await connection.database.execute<{ provider_acknowledgement: number }>(
      sql`select provider_acknowledgement from notifications where id = ${notificationId}`,
    );
    expect(result.rows[0]?.provider_acknowledgement).toBe(3);
  });
});

describe('notification schema constraints', () => {
  it('requires a scheduled time on a scheduled notification', async () => {
    await expect(
      connection.database.execute(sql`
        insert into notifications
          (id, application_id, whatsapp_session_id, status, recipient_phone_number, rendered_body)
        values ('00000000-0000-7000-8000-ffffffffff01', ${applicationId}, ${sessionId},
                'SCHEDULED', '+5511999998888', 'Hello')
      `),
    ).rejects.toThrow();
  });

  it('requires a provider message identifier once a notification is sent', async () => {
    await expect(
      connection.database.execute(sql`
        insert into notifications
          (id, application_id, whatsapp_session_id, status, recipient_phone_number, rendered_body)
        values ('00000000-0000-7000-8000-ffffffffff02', ${applicationId}, ${sessionId},
                'SENT', '+5511999998888', 'Hello')
      `),
    ).rejects.toThrow();
  });

  it('refuses a notification that references another application session', async () => {
    // The composite foreign key makes a cross-tenant reference structurally
    // impossible rather than something application code has to remember.
    const otherOrganization = await connection.database.execute<{ id: string }>(sql`
      insert into organizations (name, slug) values ('Other', ${`other-${Date.now().toString(36)}`})
      returning id
    `);
    const otherApplication = await connection.database.execute<{ id: string }>(sql`
      insert into applications (organization_id, name, slug)
      values (${otherOrganization.rows[0]?.id ?? ''}, 'Other', ${`other-${Date.now().toString(36)}`})
      returning id
    `);

    await expect(
      connection.database.execute(sql`
        insert into notifications
          (id, application_id, whatsapp_session_id, status, recipient_phone_number, rendered_body)
        values ('00000000-0000-7000-8000-ffffffffff03', ${otherApplication.rows[0]?.id ?? ''},
                ${sessionId}, 'QUEUED', '+5511999998888', 'Hello')
      `),
    ).rejects.toThrow();
  });
});

/**
 * A second tenant with a connection of its own, so a test can insert a valid
 * notification for it and isolate the one reference it is actually about. With
 * a borrowed session the composite session key fires first and the test passes
 * for the wrong reason.
 */
async function otherTenant(): Promise<{ applicationId: string; sessionId: string }> {
  notificationCounter += 1;
  const stamp = `${Date.now().toString(36)}-${String(notificationCounter)}`;
  const organization = await connection.database.execute<{ id: string }>(sql`
    insert into organizations (name, slug) values ('Other', ${`other-${stamp}`}) returning id
  `);
  const application = await connection.database.execute<{ id: string }>(sql`
    insert into applications (organization_id, name, slug)
    values (${organization.rows[0]?.id ?? ''}, 'Other', ${`other-${stamp}`})
    returning id
  `);
  const applicationId = application.rows[0]?.id ?? '';
  const session = await connection.database.execute<{ id: string }>(sql`
    insert into whatsapp_sessions
      (application_id, provider_session_name, display_name, webhook_signing_key_ciphertext)
    values (${applicationId}, ${`other-${stamp}`}, 'Other', decode('00', 'hex'))
    returning id
  `);

  return { applicationId, sessionId: session.rows[0]?.id ?? '' };
}

/** The driver reports the failed statement; Postgres's reason is on the cause. */
async function reasonFor(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
    return undefined;
  } catch (error: unknown) {
    return (error as { cause?: { message?: string } }).cause?.message;
  }
}

describe('references that could reach across a tenant boundary', () => {
  it('refuses a retry that points at another tenant notification', async () => {
    // This reference used to be a single column, so it could name any
    // notification in the table regardless of who owned it.
    const original = await createNotification('QUEUED');
    const other = await otherTenant();

    const reason = await reasonFor(
      connection.database.execute(sql`
        insert into notifications
          (id, application_id, whatsapp_session_id, status, recipient_phone_number,
           rendered_body, retry_of_notification_id)
        values ('00000000-0000-7000-8000-ffffffffff10', ${other.applicationId}, ${other.sessionId},
                'QUEUED', '+5511999998888', 'Hello', ${original})
      `),
    );

    expect(reason).toContain('notifications_retry_of_fkey');
  });

  it('refuses a notification that claims another tenant idempotency key', async () => {
    // This reference did not exist at all: the column named a row in a table
    // the database was never asked to check.
    const claim = await connection.database.execute<{ id: string }>(sql`
      insert into idempotency_keys
        (application_id, key, request_method, request_path, request_fingerprint,
         lock_token, state, expires_at)
      values (${applicationId}, ${`key-${Date.now().toString(36)}`}, 'POST', '/v1/notifications',
              decode('00', 'hex'), gen_random_uuid(), 'COMPLETED', now() + interval '1 day')
      returning id
    `);

    const other = await otherTenant();

    const reason = await reasonFor(
      connection.database.execute(sql`
        insert into notifications
          (id, application_id, whatsapp_session_id, status, recipient_phone_number,
           rendered_body, idempotency_key_id)
        values ('00000000-0000-7000-8000-ffffffffff11', ${other.applicationId}, ${other.sessionId},
                'QUEUED', '+5511999998888', 'Hello', ${claim.rows[0]?.id ?? ''})
      `),
    );

    expect(reason).toContain('notifications_idempotency_key_fkey');
  });

  it('lets the expiry reaper delete a claim a notification still names', async () => {
    // A plain ON DELETE SET NULL on a composite key nulls every referencing
    // column, application_id included — and that column is NOT NULL, so the
    // reaper would have failed on the first row it touched.
    const key = `key-${Date.now().toString(36)}-reaper`;
    const claim = await connection.database.execute<{ id: string }>(sql`
      insert into idempotency_keys
        (application_id, key, request_method, request_path, request_fingerprint,
         lock_token, state, expires_at)
      values (${applicationId}, ${key}, 'POST', '/v1/notifications',
              decode('00', 'hex'), gen_random_uuid(), 'COMPLETED', now() - interval '1 day')
      returning id
    `);
    const notificationId = '00000000-0000-7000-8000-ffffffffff12';
    await connection.database.execute(sql`
      insert into notifications
        (id, application_id, whatsapp_session_id, status, recipient_phone_number,
         rendered_body, idempotency_key_id)
      values (${notificationId}, ${applicationId}, ${sessionId}, 'QUEUED', '+5511999998888',
              'Hello', ${claim.rows[0]?.id ?? ''})
    `);

    await connection.database.execute(sql`
      delete from idempotency_keys where id = ${claim.rows[0]?.id ?? ''}
    `);

    const after = await connection.database.execute<{
      application_id: string;
      idempotency_key_id: string | null;
    }>(sql`
      select application_id, idempotency_key_id from notifications where id = ${notificationId}
    `);
    expect(after.rows[0]?.idempotency_key_id).toBeNull();
    expect(after.rows[0]?.application_id).toBe(applicationId);
  });
});
