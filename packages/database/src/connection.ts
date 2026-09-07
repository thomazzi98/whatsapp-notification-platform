import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';

import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;

export interface ConnectionOptions {
  readonly connectionUrl: string;
  readonly maximumPoolSize: number;
  readonly statementTimeoutMilliseconds?: number;
  readonly applicationName: string;
}

export interface DatabaseConnection {
  readonly database: Database;
  readonly pool: Pool;
  close: () => Promise<void>;
}

/**
 * Two connections exist by design. The application role is subject to row level
 * security and is what serves requests; the system role bypasses it and is used
 * only for migrations and maintenance. Keeping them separate is what makes the
 * row level security policies meaningful rather than decorative.
 */
export function createDatabaseConnection(options: ConnectionOptions): DatabaseConnection {
  const poolConfiguration: PoolConfig = {
    connectionString: options.connectionUrl,
    max: options.maximumPoolSize,
    application_name: options.applicationName,
  };

  if (options.statementTimeoutMilliseconds !== undefined) {
    poolConfiguration.statement_timeout = options.statementTimeoutMilliseconds;
  }

  const pool = new Pool(poolConfiguration);
  const database = drizzle(pool, { schema });

  return {
    database,
    pool,
    close: async () => {
      await pool.end();
    },
  };
}
