import path from 'node:path';

/**
 * Resolved relative to the compiled output rather than the working directory,
 * so the migrate container finds the SQL files wherever pnpm deploy places the
 * package. The migrations directory is listed in `files`, so it travels with
 * the package into the production image.
 */
export const migrationsFolder = path.resolve(__dirname, '../migrations');
