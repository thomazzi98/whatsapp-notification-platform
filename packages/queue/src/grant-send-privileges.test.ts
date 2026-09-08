import { describe, expect, it } from 'vitest';

import { grantSendPrivileges, readRoleFromConnectionUrl } from './grant-send-privileges';

describe('readRoleFromConnectionUrl', () => {
  it('reads the role a connection string logs in as', () => {
    expect(readRoleFromConnectionUrl('postgres://platform_application:secret@db:5432/app')).toBe(
      'platform_application',
    );
  });

  it('decodes a role name that had to be escaped in the URL', () => {
    expect(readRoleFromConnectionUrl('postgres://role%40host:secret@db:5432/app')).toBe(
      'role@host',
    );
  });

  it('reports a connection string with no role rather than guessing one', () => {
    expect(readRoleFromConnectionUrl('postgres://db:5432/app')).toBeUndefined();
  });

  it('reports an unparseable connection string rather than throwing', () => {
    // The bootstrap reads this from the environment, and a malformed value
    // should produce its own error message rather than a URL parse stack trace.
    expect(readRoleFromConnectionUrl('not a connection string')).toBeUndefined();
  });
});

describe('grantSendPrivileges', () => {
  /**
   * Postgres cannot parameterise an identifier, so the role and schema are
   * interpolated into the statement. They are validated first, and these tests
   * are the reason that validation cannot quietly be dropped.
   */
  it.each([
    'platform_application; drop table users',
    'role"; --',
    "role'",
    '',
    '1_starts_with_a_digit',
  ])('refuses the role name %j before opening a connection', async (role) => {
    await expect(
      grantSendPrivileges('postgres://unreachable.invalid:5432/app', 'pgboss', role),
    ).rejects.toThrow('not a valid Postgres identifier');
  });

  it('refuses a schema name that is not an identifier', async () => {
    await expect(
      grantSendPrivileges(
        'postgres://unreachable.invalid:5432/app',
        'pgboss; drop schema public',
        'app_role',
      ),
    ).rejects.toThrow('not a valid Postgres identifier');
  });
});
