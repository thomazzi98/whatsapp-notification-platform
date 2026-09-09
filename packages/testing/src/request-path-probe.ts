import { createDatabaseConnection } from '@platform/database';
import { sql } from 'drizzle-orm';

/**
 * A login role that can authenticate a request but cannot serve one.
 *
 * Row level security protects tenant data only while `current_user` is
 * `platform_tenant`; the policy predicate begins `current_user <> 'platform_tenant'`,
 * so for every other role it is trivially true. The whole layer is therefore
 * conditional on the request path having called `withTenantScope` — and nothing
 * proved it did. Deleting the wrapper left the suite green, because the
 * repositories filter by application id anyway and the tests connect as the
 * table owner, for whom policies never apply.
 *
 * This role closes that hole by making the privilege the thing under test. It
 * holds everything the pre-scope path needs — resolving an API key, reading the
 * application, metering the rate limiter — and nothing at all on the tables the
 * scoped path touches. Those arrive only from `platform_tenant`, and only for
 * the length of a transaction that assumed it.
 *
 * `NOINHERIT` is what makes the assertion sharp: membership alone grants
 * nothing, so the privileges appear if and only if `SET LOCAL ROLE` actually
 * ran. Production's login role inherits and holds its own grants, which is why
 * the gap is invisible there; this role is the instrument that makes it visible.
 */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

function assertSafeIdentifier(value: string, what: string): void {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(`The ${what} "${value}" is not a valid Postgres identifier.`);
  }
}

export interface RequestPathProbeRole {
  /** Point `database.applicationUrl` at this to route a request through the role. */
  readonly connectionUrl: string;
  readonly roleName: string;
  /**
   * Reads a withheld table as the bare login role. Rejects, and the reason it
   * gives is what makes the rest of the suite mean anything.
   *
   * Exposed here rather than left to the caller because the API application
   * must not depend on `@platform/database` — a layering rule the cruise
   * enforces — and a test living beside it inherits that constraint.
   */
  readWithoutScope: (table: string) => Promise<readonly unknown[]>;
  /** The same read, inside the scope the request path is supposed to establish. */
  readWithinScope: (table: string, applicationId: string) => Promise<readonly unknown[]>;
  /**
   * What the role may do to a table without assuming anything.
   *
   * The suite asserts these are all false for every withheld table. Without
   * that, a `REVOKE` that silently stopped covering one table would leave the
   * matching call site unpinned and every test still green.
   */
  privilegesOn: (
    table: string,
  ) => Promise<Record<'select' | 'insert' | 'update' | 'delete', boolean>>;
  /** False, or membership alone would grant what only `SET ROLE` should. */
  inheritsTenantRole: () => Promise<boolean>;
  close: () => Promise<void>;
}

export async function createRequestPathProbeRole(options: {
  readonly ownerConnectionUrl: string;
  readonly roleName: string;
  readonly password: string;
  /** The tables the scoped path touches, which this role must not reach directly. */
  readonly withheldTables: readonly string[];
}): Promise<RequestPathProbeRole> {
  assertSafeIdentifier(options.roleName, 'role name');
  assertSafeIdentifier(options.password, 'role password');
  for (const table of options.withheldTables) {
    assertSafeIdentifier(table, 'withheld table');
  }

  const owner = createDatabaseConnection({
    connectionUrl: options.ownerConnectionUrl,
    maximumPoolSize: 1,
    applicationName: 'test-probe-role',
  });
  const databaseName = new URL(options.ownerConnectionUrl).pathname.slice(1);
  assertSafeIdentifier(databaseName, 'database name');
  const withheld = options.withheldTables.join(', ');

  try {
    // Privileges granted to a role are dependencies of it, so the role cannot
    // be dropped while it holds any. Re-running a file against a container that
    // already has the role has to clear those first.
    await owner.database.execute(
      sql.raw(`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${options.roleName}') THEN
            EXECUTE 'DROP OWNED BY ${options.roleName}';
            EXECUTE 'DROP ROLE ${options.roleName}';
          END IF;
        END $$;
      `),
    );

    await owner.database.execute(
      sql.raw(`CREATE ROLE ${options.roleName} LOGIN NOINHERIT PASSWORD '${options.password}'`),
    );
    await owner.database.execute(
      sql.raw(`GRANT CONNECT ON DATABASE "${databaseName}" TO ${options.roleName}`),
    );
    await owner.database.execute(sql.raw(`GRANT USAGE ON SCHEMA public TO ${options.roleName}`));

    // Everything the production login role gets by default privilege, so the
    // only difference between this role and that one is the withheld tables.
    await owner.database.execute(
      sql.raw(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${options.roleName}`,
      ),
    );
    await owner.database.execute(
      sql.raw(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${options.roleName}`),
    );
    await owner.database.execute(sql.raw(`REVOKE ALL ON ${withheld} FROM ${options.roleName}`));
    await owner.database.execute(sql.raw(`GRANT platform_tenant TO ${options.roleName}`));
  } finally {
    await owner.close();
  }

  const probeUrl = new URL(options.ownerConnectionUrl);
  probeUrl.username = options.roleName;
  probeUrl.password = options.password;
  const connectionUrl = probeUrl.href;

  const probe = createDatabaseConnection({
    connectionUrl,
    maximumPoolSize: 1,
    applicationName: 'test-probe-assertions',
  });

  return {
    connectionUrl,
    roleName: options.roleName,
    readWithoutScope: async (table: string) => {
      assertSafeIdentifier(table, 'table');
      const result = await probe.database.execute(sql.raw(`select id from ${table}`));

      return result.rows;
    },
    readWithinScope: async (table: string, applicationId: string) => {
      assertSafeIdentifier(table, 'table');

      return probe.database.transaction(async (transaction) => {
        await transaction.execute(sql`SET LOCAL ROLE platform_tenant`);
        await transaction.execute(
          sql`SELECT set_config('app.current_application_id', ${applicationId}, true)`,
        );
        const result = await transaction.execute(sql.raw(`select id from ${table}`));

        return result.rows;
      });
    },
    privilegesOn: async (table: string) => {
      assertSafeIdentifier(table, 'table');
      const result = await probe.database.execute<{
        select: boolean;
        insert: boolean;
        update: boolean;
        delete: boolean;
      }>(sql`
        select
          has_table_privilege(${options.roleName}, ${table}, 'SELECT') as select,
          has_table_privilege(${options.roleName}, ${table}, 'INSERT') as insert,
          has_table_privilege(${options.roleName}, ${table}, 'UPDATE') as update,
          has_table_privilege(${options.roleName}, ${table}, 'DELETE') as delete
      `);
      const row = result.rows[0];

      return {
        select: row?.select ?? true,
        insert: row?.insert ?? true,
        update: row?.update ?? true,
        delete: row?.delete ?? true,
      };
    },
    inheritsTenantRole: async () => {
      const result = await probe.database.execute<{ inherits: boolean }>(sql`
        select member.inherit_option as inherits
        from pg_auth_members member
        join pg_roles granted on granted.oid = member.roleid
        join pg_roles grantee on grantee.oid = member.member
        where granted.rolname = 'platform_tenant' and grantee.rolname = ${options.roleName}
      `);

      return result.rows[0]?.inherits ?? true;
    },
    close: async () => {
      await probe.close();
    },
  };
}
