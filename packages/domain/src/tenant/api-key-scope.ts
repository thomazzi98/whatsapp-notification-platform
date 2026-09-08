export const apiKeyScopes = [
  'notifications:write',
  'notifications:read',
  'templates:write',
  'templates:read',
  'sessions:read',
] as const;

export type ApiKeyScope = (typeof apiKeyScopes)[number];

/**
 * What a key gets when the request names no scopes: enough to send and to check
 * what happened. Nothing that no route checks yet, because a default that
 * grants nothing only makes the granted list harder to read.
 */
export const defaultApiKeyScopes: readonly ApiKeyScope[] = [
  'notifications:write',
  'notifications:read',
];

export function isApiKeyScope(candidate: string): candidate is ApiKeyScope {
  return (apiKeyScopes as readonly string[]).includes(candidate);
}

export function hasScope(granted: readonly ApiKeyScope[], required: ApiKeyScope): boolean {
  return granted.includes(required);
}
