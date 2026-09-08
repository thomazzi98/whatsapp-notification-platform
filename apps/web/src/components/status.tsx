import { type NotificationStatus, type ProviderSessionStatus } from '@platform/domain';
import { type ReactNode } from 'react';

import { Badge, type Tone } from './ui';

interface StatusPresentation {
  readonly label: string;
  readonly tone: Tone;
  /**
   * A glyph, not a colour swatch. Status has to survive being printed in black
   * and white, read by someone who cannot distinguish red from green, or
   * skimmed by someone who has not learned this product's palette.
   */
  readonly icon: string;
  readonly meaning: string;
}

const notificationPresentation: Record<NotificationStatus, StatusPresentation> = {
  SCHEDULED: {
    label: 'Scheduled',
    tone: 'neutral',
    icon: '◷',
    meaning: 'Waiting for the time it was scheduled for.',
  },
  QUEUED: {
    label: 'Queued',
    tone: 'neutral',
    icon: '•',
    meaning: 'Accepted and waiting for a worker to pick it up.',
  },
  PROCESSING: {
    label: 'Processing',
    tone: 'accent',
    icon: '⟳',
    meaning: 'A worker is handing it to WhatsApp right now.',
  },
  RETRYING: {
    label: 'Retrying',
    tone: 'caution',
    icon: '↻',
    meaning: 'An attempt did not succeed and another is scheduled.',
  },
  SENT: {
    label: 'Sent',
    tone: 'accent',
    icon: '↑',
    meaning: 'WhatsApp accepted it. Nobody has received it yet.',
  },
  DELIVERED: {
    label: 'Delivered',
    tone: 'positive',
    icon: '✓',
    meaning: "It reached the recipient's device.",
  },
  FAILED: {
    label: 'Failed',
    tone: 'negative',
    icon: '✕',
    meaning: 'It will not be attempted again.',
  },
  CANCELLED: {
    label: 'Cancelled',
    tone: 'neutral',
    icon: '⊘',
    meaning: 'Cancelled before it was handed to WhatsApp.',
  },
};

const connectionPresentation: Record<ProviderSessionStatus, StatusPresentation> = {
  STOPPED: {
    label: 'Stopped',
    tone: 'neutral',
    icon: '◼',
    meaning: 'Not running. Starting it resumes the existing pairing.',
  },
  STARTING: {
    label: 'Starting',
    tone: 'accent',
    icon: '⟳',
    meaning: 'Coming up.',
  },
  SCAN_QR_CODE: {
    label: 'Waiting for a scan',
    tone: 'caution',
    icon: '▣',
    meaning: 'Ready to pair with a phone.',
  },
  WORKING: {
    label: 'Connected',
    tone: 'positive',
    icon: '✓',
    meaning: 'Paired and able to send.',
  },
  FAILED: {
    label: 'Failed',
    tone: 'negative',
    icon: '✕',
    meaning: 'The connection could not be established.',
  },
  UNKNOWN: {
    label: 'Unrecognised',
    tone: 'caution',
    icon: '?',
    meaning: 'The provider reported a state this version does not know.',
  },
};

/**
 * Derived from the presentation tables rather than imported.
 *
 * The tables are `Record`s keyed by the status union, so a status added to the
 * domain is a compile error here — the list cannot fall behind — and the
 * dashboard keeps its runtime free of the server's packages, which compile to
 * CommonJS and would drag the whole domain into the browser bundle.
 */
export const notificationStatusOrder = Object.keys(
  notificationPresentation,
) as NotificationStatus[];

export function NotificationStatusBadge({ status }: { status: NotificationStatus }): ReactNode {
  const presentation = notificationPresentation[status];

  return (
    <Badge tone={presentation.tone} icon={<span aria-hidden="true">{presentation.icon}</span>}>
      {presentation.label}
    </Badge>
  );
}

export function describeNotificationStatus(status: NotificationStatus): string {
  return notificationPresentation[status].meaning;
}

export function ConnectionStatusBadge({ status }: { status: ProviderSessionStatus }): ReactNode {
  const presentation = connectionPresentation[status];

  return (
    <Badge tone={presentation.tone} icon={<span aria-hidden="true">{presentation.icon}</span>}>
      {presentation.label}
    </Badge>
  );
}

export function describeConnectionStatus(status: ProviderSessionStatus): string {
  return connectionPresentation[status].meaning;
}
