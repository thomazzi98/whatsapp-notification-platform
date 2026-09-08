import { type ApiKeyScope } from '@platform/domain';

/**
 * What each scope actually permits, in the words of someone deciding whether to
 * grant it. The list is a `Record` keyed by the scope union, so a scope added to
 * the domain is a compile error here rather than a checkbox that silently never
 * appears.
 *
 * Written out rather than imported at runtime: the server packages compile to
 * CommonJS, and importing a value from one drags the entire domain into the
 * browser bundle for the sake of an array of strings.
 */
const scopeDescriptions: Record<ApiKeyScope, string> = {
  'notifications:write': 'Send notifications and cancel ones that have not gone out yet.',
  'notifications:read': 'Read notifications and their delivery history.',
  'templates:write': 'Create and change message templates.',
  'templates:read': 'Read message templates.',
  'sessions:read': 'Read the state of the WhatsApp connections.',
};

/**
 * Scopes no route checks yet.
 *
 * They stay in the vocabulary, so a key issued with one remains valid and the
 * names do not have to be invented twice — but a checkbox that grants nothing
 * is worse than an absent one. Templates have a table and no API; connection
 * state is deliberately a dashboard concern, because pairing needs a person.
 */
const scopesWithoutAnEndpoint = new Set<ApiKeyScope>([
  'templates:write',
  'templates:read',
  'sessions:read',
]);

export const availableScopes = (Object.keys(scopeDescriptions) as ApiKeyScope[]).filter(
  (scope) => !scopesWithoutAnEndpoint.has(scope),
);

export function describeScope(scope: ApiKeyScope): string {
  return scopeDescriptions[scope];
}

/**
 * What a new key gets unless somebody chooses otherwise: enough to send and to
 * check what happened, and nothing else.
 */
export const suggestedScopes: readonly ApiKeyScope[] = [
  'notifications:write',
  'notifications:read',
];
