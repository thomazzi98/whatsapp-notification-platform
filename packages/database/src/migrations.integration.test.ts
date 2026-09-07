import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { applyMigrations } from './bootstrap';
import { createDatabaseConnection, type DatabaseConnection } from './connection';

const migrationsFolder = './migrations';

let connection: DatabaseConnection;

beforeAll(async () => {
  connection = createDatabaseConnection({
    connectionUrl: inject('databaseUrl'),
    maximumPoolSize: 4,
    applicationName: 'migration-integration-test',
  });

  await applyMigrations({
    database: connection.database,
    pool: connection.pool,
    migrationsFolder,
  });
}, 180_000);

afterAll(async () => {
  await connection.close();
});

async function tableNames(): Promise<string[]> {
  const result = await connection.database.execute<{ table_name: string }>(
    sql`select table_name from information_schema.tables
        where table_schema = 'public' order by table_name`,
  );
  return result.rows.map((row) => row.table_name);
}

async function indexNames(tableName: string): Promise<string[]> {
  const result = await connection.database.execute<{ indexname: string }>(
    sql`select indexname from pg_indexes
        where schemaname = 'public' and tablename = ${tableName}
        order by indexname`,
  );
  return result.rows.map((row) => row.indexname);
}

async function insertOrganization(slug: string): Promise<string> {
  const result = await connection.database.execute<{ id: string }>(sql`
    insert into organizations (name, slug) values (${slug}, ${slug}) returning id
  `);
  const identifier = result.rows[0]?.id;
  if (identifier === undefined) {
    throw new Error('Failed to insert the test organization.');
  }
  return identifier;
}

async function insertApplication(organizationId: string, slug: string): Promise<string> {
  const result = await connection.database.execute<{ id: string }>(sql`
    insert into applications (organization_id, name, slug)
    values (${organizationId}, ${slug}, ${slug}) returning id
  `);
  const identifier = result.rows[0]?.id;
  if (identifier === undefined) {
    throw new Error('Failed to insert the test application.');
  }
  return identifier;
}

interface PostgresErrorCause {
  readonly constraint?: string;
  readonly code?: string;
}

/**
 * Drizzle wraps driver errors in a "Failed query" message and keeps the
 * Postgres detail on `cause`. Asserting the exact constraint name is stronger
 * than matching the message: it fails if a rename silently changes which rule
 * rejected the row.
 */
async function violatedConstraint(operation: Promise<unknown>): Promise<string | undefined> {
  try {
    await operation;
    return undefined;
  } catch (error: unknown) {
    const cause = (error as { cause?: PostgresErrorCause }).cause;
    return cause?.constraint;
  }
}

describe('migrations', () => {
  it('creates every table the schema declares', async () => {
    const tables = await tableNames();

    expect(tables).toEqual(
      expect.arrayContaining([
        'api_keys',
        'applications',
        'organizations',
        'user_sessions',
        'users',
      ]),
    );
  });

  it('is idempotent, so a second process starting concurrently is harmless', async () => {
    await applyMigrations({
      database: connection.database,
      pool: connection.pool,
      migrationsFolder,
    });

    const tables = await tableNames();
    expect(tables).toEqual(expect.arrayContaining(['applications', 'organizations']));
  });

  it('creates the partial indexes that keep hot lookups proportional to live rows', async () => {
    expect(await indexNames('user_sessions')).toEqual(
      expect.arrayContaining([
        'user_sessions_token_hash_unique',
        'user_sessions_active_by_user_index',
        'user_sessions_idle_expires_at_index',
      ]),
    );
    expect(await indexNames('api_keys')).toEqual(
      expect.arrayContaining([
        'api_keys_key_identifier_unique',
        'api_keys_key_hash_unique',
        'api_keys_active_by_application_index',
      ]),
    );
  });

  it('indexes organization slugs case-insensitively', async () => {
    const result = await connection.database.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes
          where schemaname = 'public' and indexname = 'organizations_slug_unique'`,
    );

    expect(result.rows[0]?.indexdef).toContain('lower(slug)');
  });
});

describe('schema constraints', () => {
  it('rejects an unknown user role', async () => {
    const organizationId = await insertOrganization('constraint-role');

    const constraint = await violatedConstraint(
      connection.database.execute(sql`
        insert into users (organization_id, email, password_hash, name, role)
        values (${organizationId}, 'role@example.com', 'hash', 'Role', 'SUPERUSER')
      `),
    );

    expect(constraint).toBe('users_role_check');
  });

  it('rejects a rate limit outside the supported range', async () => {
    const organizationId = await insertOrganization('constraint-rate');

    const constraint = await violatedConstraint(
      connection.database.execute(sql`
        insert into applications (organization_id, name, slug, rate_limit_per_minute)
        values (${organizationId}, 'Too fast', 'too-fast', 60000)
      `),
    );

    expect(constraint).toBe('applications_rate_limit_per_minute_check');
  });

  it('rejects an api key with no scopes, which would authenticate but authorize nothing', async () => {
    const organizationId = await insertOrganization('constraint-scopes');
    const applicationId = await insertApplication(organizationId, 'scopes');

    const constraint = await violatedConstraint(
      connection.database.execute(sql`
        insert into api_keys
          (application_id, name, key_identifier, key_prefix, key_hash, last_four, scopes)
        values
          (${applicationId}, 'empty', 'identifier-empty', 'wnp_test_', decode('00', 'hex'), '1234', '{}')
      `),
    );

    expect(constraint).toBe('api_keys_scopes_not_empty_check');
  });

  it('keeps application slugs unique within an organization but not across organizations', async () => {
    const firstOrganizationId = await insertOrganization('slug-first');
    const secondOrganizationId = await insertOrganization('slug-second');

    await insertApplication(firstOrganizationId, 'production');
    await insertApplication(secondOrganizationId, 'production');

    const constraint = await violatedConstraint(
      insertApplication(firstOrganizationId, 'production'),
    );

    expect(constraint).toBe('applications_organization_slug_unique');
  });

  it('cascades a deleted organization to its applications', async () => {
    const organizationId = await insertOrganization('cascade');
    await insertApplication(organizationId, 'cascade-application');

    await connection.database.execute(sql`delete from organizations where id = ${organizationId}`);

    const remaining = await connection.database.execute<{ count: string }>(
      sql`select count(*)::text as count from applications where organization_id = ${organizationId}`,
    );
    expect(remaining.rows[0]?.count).toBe('0');
  });

  it('enforces the case-insensitive uniqueness of user emails', async () => {
    const organizationId = await insertOrganization('email-uniqueness');

    await connection.database.execute(sql`
      insert into users (organization_id, email, password_hash, name)
      values (${organizationId}, 'Person@Example.com', 'hash', 'Person')
    `);

    const constraint = await violatedConstraint(
      connection.database.execute(sql`
        insert into users (organization_id, email, password_hash, name)
        values (${organizationId}, 'person@example.com', 'hash', 'Person Again')
      `),
    );

    expect(constraint).toBe('users_email_unique');
  });
});
