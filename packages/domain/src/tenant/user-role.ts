export const userRoles = ['OWNER', 'ADMIN', 'MEMBER'] as const;

export type UserRole = (typeof userRoles)[number];

export const userStatuses = ['ACTIVE', 'DISABLED'] as const;

export type UserStatus = (typeof userStatuses)[number];

/**
 * Ordered from least to most privileged, so an authorization check is a
 * comparison rather than a set of nested conditions.
 */
const rolePrivilegeOrder: Record<UserRole, number> = {
  MEMBER: 0,
  ADMIN: 1,
  OWNER: 2,
};

export function hasAtLeastRole(actual: UserRole, required: UserRole): boolean {
  return rolePrivilegeOrder[actual] >= rolePrivilegeOrder[required];
}
