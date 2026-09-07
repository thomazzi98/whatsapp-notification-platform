import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import * as schema from './index';

const tables: readonly (readonly [string, PgTable])[] = Object.entries(schema);

const SNAKE_CASE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/**
 * Reference data rather than rows with a lifecycle. They are seeded by a
 * migration and never change, so a creation timestamp would carry no meaning.
 */
const LOOKUP_TABLES = new Set(['notificationStatusTable', 'notificationStatusTransitions']);

describe('schema naming', () => {
  it('exports every table the platform expects at this stage', () => {
    // Membership, not ordering: the export order carries no meaning.
    expect(new Set(tables.map(([exportName]) => exportName))).toEqual(
      new Set([
        'apiKeys',
        'applications',
        'idempotencyKeys',
        'notificationEvents',
        'notifications',
        'notificationSendAttempts',
        'notificationStatusTable',
        'notificationStatusTransitions',
        'organizations',
        'templates',
        'userSessions',
        'users',
        'whatsAppSessions',
      ]),
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
      const configuration = getTableConfig(table);
      const inlinePrimaryKeyColumns = configuration.columns.filter((column) => column.primary);
      const hasPrimaryKey =
        inlinePrimaryKeyColumns.length > 0 || configuration.primaryKeys.length > 0;

      expect(hasPrimaryKey, `${exportName} primary key`).toBe(true);
    }
  });

  it('records when every row was created, which the delivery timeline depends on', () => {
    const lifecycleTables = tables.filter(([exportName]) => !LOOKUP_TABLES.has(exportName));

    for (const [exportName, table] of lifecycleTables) {
      const columnNames = new Set(getTableConfig(table).columns.map((column) => column.name));
      const hasTimestamp =
        columnNames.has('created_at') ||
        columnNames.has('occurred_at') ||
        columnNames.has('request_started_at');

      expect(hasTimestamp, `${exportName} has a creation timestamp`).toBe(true);
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
