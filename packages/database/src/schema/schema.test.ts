import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import * as schema from './index';

const tables: readonly (readonly [string, PgTable])[] = Object.entries(schema);

const SNAKE_CASE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

describe('schema naming', () => {
  it('exports every table the platform expects at this stage', () => {
    // Membership, not ordering: the export order carries no meaning.
    expect(new Set(tables.map(([exportName]) => exportName))).toEqual(
      new Set(['apiKeys', 'applications', 'organizations', 'userSessions', 'users']),
    );
  });

  it('names every table in snake_case, matching the SQL in the migrations', () => {
    for (const [exportName, table] of tables) {
      const { name } = getTableConfig(table);
      expect(name, `${exportName} table name`).toMatch(SNAKE_CASE);
    }
  });

  it('names every column in snake_case', () => {
    for (const [exportName, table] of tables) {
      for (const column of getTableConfig(table).columns) {
        expect(column.name, `${exportName}.${column.name}`).toMatch(SNAKE_CASE);
      }
    }
  });

  it('gives every table a primary key, so no row is unaddressable', () => {
    for (const [exportName, table] of tables) {
      const { columns } = getTableConfig(table);
      const primaryKeyColumns = columns.filter((column) => column.primary);

      expect(primaryKeyColumns.length, `${exportName} primary key`).toBeGreaterThan(0);
    }
  });

  it('records when every row was created, which the delivery timeline depends on', () => {
    for (const [exportName, table] of tables) {
      const columnNames = getTableConfig(table).columns.map((column) => column.name);

      expect(columnNames, `${exportName} columns`).toContain('created_at');
    }
  });
});

describe('schema safety', () => {
  it('never stores a credential in a plain text column', () => {
    const forbiddenPlainTextColumns = new Set(['password', 'api_key', 'secret', 'token']);

    for (const [exportName, table] of tables) {
      for (const column of getTableConfig(table).columns) {
        expect(
          forbiddenPlainTextColumns.has(column.name),
          `${exportName}.${column.name} looks like a plain text credential`,
        ).toBe(false);
      }
    }
  });

  it('stores credential digests as bytea rather than text', () => {
    const digestColumnNames = new Set(['token_hash', 'key_hash']);

    for (const [, table] of tables) {
      const digestColumns = getTableConfig(table).columns.filter((column) =>
        digestColumnNames.has(column.name),
      );

      for (const column of digestColumns) {
        expect(column.getSQLType()).toBe('bytea');
      }
    }
  });
});
