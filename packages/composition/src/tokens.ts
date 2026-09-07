/**
 * Injection tokens for adapters that have no single natural class to inject.
 *
 * Domain ports carry their own symbols, exported from the domain package, so
 * this file holds only what is specific to wiring infrastructure.
 */
export const DATABASE_CONNECTION = Symbol('DatabaseConnection');
export const APPLICATION_CONFIGURATION = Symbol('ApplicationConfiguration');
export const QUEUE_CLIENT = Symbol('QueueClient');
