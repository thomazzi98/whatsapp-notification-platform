import { type Pool } from 'pg';

/**
 * Postgres identifiers cannot be parameterised, so the schema name is validated
 * rather than escaped. It comes from configuration rather than from a request,
 * and refusing an unexpected shape is cheaper than reasoning about quoting.
 */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/**
 * The queues this database has been told about.
 *
 * A missing schema, a missing table or a missing grant all raise, and the
 * reason Postgres gives is more useful than anything a catalogue lookup here
 * could reconstruct.
 */
export async function readDeclaredQueueNames(pool: Pool, schema: string): Promise<string[]> {
  if (!SAFE_IDENTIFIER.test(schema)) {
    throw new Error(`The queue schema "${schema}" is not a valid Postgres identifier.`);
  }

  const result = await pool.query<{ name: string }>(`SELECT name FROM ${schema}.queue`);

  return result.rows.map((row) => row.name);
}
