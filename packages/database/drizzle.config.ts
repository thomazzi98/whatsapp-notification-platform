import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  // pg-boss owns its own schema and manages its own migrations; drizzle-kit
  // must not try to reconcile those tables.
  schemaFilter: ['public'],
  dbCredentials: {
    url: process.env.DATABASE_SYSTEM_URL ?? 'postgres://localhost:5432/notifications',
  },
  strict: true,
  verbose: true,
});
