import { sql } from 'drizzle-orm';
import { Client } from 'pg';

import { type Database } from './connection';
import { type DatabaseTransaction } from './repositories/notification.repository';

/**
 * The role every API-key authenticated request runs as.
 *
 * It cannot log in, so it is reachable only through this function — there is no
 * connection string anywhere that could accidentally be pointed at it, and no
 * password to leak.
 */
export const TENANT_ROLE = 'platform_tenant';

/**
 * Runs work as a role that can only see one application's rows.
 *
 * Both statements are transaction-local. A pooled connection returned to the
 * pool mid-request therefore cannot carry the role or the application id into
 * whatever runs on it next, which is the failure mode that makes session-level
 * `SET ROLE` unsafe behind a connection pool.
 *
 * This is a second line of defence, not the first. The repositories still scope
 * every query by application id; what this adds is that forgetting to do so
 * returns nothing rather than another tenant's data.
 */
export async function withTenantScope<T>(
  database: Database,
  applicationId: string,
  work: (transaction: DatabaseTransaction) => Promise<T>,
): Promise<T> {
  return database.transaction(async (transaction) => {
    await transaction.execute(sql`SET LOCAL ROLE platform_tenant`);
    await transaction.execute(
      sql`SELECT set_config('app.current_application_id', ${applicationId}, true)`,
    );

    return work(transaction);
  });
}

/**
 * Postgres identifiers cannot be parameterised, so the role name is validated
 * rather than escaped. Anything outside this shape is refused instead of being
 * quoted and hoped for.
 */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/**
 * Lets the login role assume the tenant role.
 *
 * Run on every boot rather than once at database creation: an installation that
 * predates the tenant role would otherwise keep a database the API cannot serve
 * from, and the failure would appear as an authorisation error on every
 * API-key request rather than as a missing migration.
 */
export async function grantTenantRoleMembership(
  systemConnectionUrl: string,
  loginRole: string,
): Promise<void> {
  if (!SAFE_IDENTIFIER.test(loginRole)) {
    throw new Error(`The role "${loginRole}" is not a valid Postgres identifier.`);
  }

  const client = new Client({ connectionString: systemConnectionUrl });
  await client.connect();

  try {
    await client.query(`GRANT ${TENANT_ROLE} TO ${loginRole}`);
  } finally {
    await client.end();
  }
}
