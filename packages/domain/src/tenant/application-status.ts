export const applicationStatuses = ['ACTIVE', 'SUSPENDED'] as const;

export type ApplicationStatus = (typeof applicationStatuses)[number];

export function canApplicationAcceptNotifications(status: ApplicationStatus): boolean {
  return status === 'ACTIVE';
}
