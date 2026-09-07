export const apiKeyScopes = [
  'notifications:write',
  'notifications:read',
  'templates:write',
  'templates:read',
  'sessions:read',
] as const;

export type ApiKeyScope = (typeof apiKeyScopes)[number];

export const defaultApiKeyScopes: readonly ApiKeyScope[] = [
  'notifications:write',
  'notifications:read',
  'templates:read',
];

export function isApiKeyScope(candidate: string): candidate is ApiKeyScope {
  return (apiKeyScopes as readonly string[]).includes(candidate);
}

export function hasScope(granted: readonly ApiKeyScope[], required: ApiKeyScope): boolean {
  return granted.includes(required);
}
