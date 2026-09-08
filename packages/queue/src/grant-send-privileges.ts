import { Client } from 'pg';

/**
 * Postgres identifiers are not parameterisable, so the role name is validated
 * rather than escaped. Anything outside this shape is refused instead of being
 * quoted and hoped for.
 */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

function assertSafeIdentifier(value: string, what: string): void {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(`The ${what} "${value}" is not a valid Postgres identifier.`);
  }
}

/**
 * Reads the role a connection string logs in as.
 *
 * The bootstrap step needs the application role's name, and the connection
 * string is the one place it is already configured — asking for it a second
 * time in its own variable would create two sources of truth that can disagree.
 */
export function readRoleFromConnectionUrl(connectionUrl: string): string | undefined {
  try {
    const parsed = new URL(connectionUrl);
    const role = decodeURIComponent(parsed.username);

    return role.length > 0 ? role : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Lets the tenant-scoped role write dispatch jobs.
 *
 * The queue schema is owned by the system role, but a notification and its
 * dispatch job must commit in one transaction, and that transaction belongs to
 * the application role. Without this grant the enqueue fails with a permission
 * error and the whole transactional guarantee collapses into a 500.
 *
 * The privileges are the narrowest that allow a send: reading the queue
 * definitions and inserting a job. Claiming, completing and archiving jobs stay
 * out of reach of the process that handles untrusted requests.
 */
export async function grantSendPrivileges(
  systemConnectionUrl: string,
  schema: string,
  applicationRole: string,
): Promise<void> {
  assertSafeIdentifier(schema, 'queue schema');
  assertSafeIdentifier(applicationRole, 'application role');

  const client = new Client({ connectionString: systemConnectionUrl });
  await client.connect();

  try {
    await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${applicationRole}`);
    await client.query(
      `GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA ${schema} TO ${applicationRole}`,
    );
    // pg-boss creates a partition per queue, so a queue added later would
    // otherwise arrive without the grant and fail the first time it is used.
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT, INSERT ON TABLES TO ${applicationRole}`,
    );
  } finally {
    await client.end();
  }
}
