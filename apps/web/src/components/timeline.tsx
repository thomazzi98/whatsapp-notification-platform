import { type NotificationEventResponse, type NotificationResponse } from '@platform/contracts';
import { type ReactNode } from 'react';

import { Alert, Panel, Timestamp } from './ui';

interface AttemptGroup {
  readonly attemptNumber: number | null;
  readonly events: readonly NotificationEventResponse[];
}

const eventLabels: Readonly<Record<string, string>> = {
  'notification.created': 'Accepted',
  'notification.queued': 'Scheduled time reached',
  'notification.sent': 'Handed to WhatsApp',
  'notification.retry_scheduled': 'Retry scheduled',
  'notification.failed': 'Failed',
  'notification.cancelled': 'Cancelled',
  'notification.acknowledged': 'Acknowledged by WhatsApp',
  'notification.claim_reaped': 'Recovered from an interrupted attempt',
};

/**
 * Groups the history by attempt, because that is the unit a person reasons in:
 * "the third try failed" is a sentence; "event seven of eleven" is not.
 */
function groupByAttempt(events: readonly NotificationEventResponse[]): AttemptGroup[] {
  const groups: AttemptGroup[] = [];

  for (const event of events) {
    const last = groups.at(-1);

    if (last?.attemptNumber === event.attemptNumber) {
      groups[groups.length - 1] = {
        attemptNumber: last.attemptNumber,
        events: [...last.events, event],
      };
      continue;
    }
    groups.push({ attemptNumber: event.attemptNumber, events: [event] });
  }

  return groups;
}

function describePayload(event: NotificationEventResponse): string | undefined {
  const payload = event.payload;
  const parts: string[] = [];

  if (typeof payload.failureCode === 'string') {
    parts.push(payload.failureCode);
  }
  if (typeof payload.acknowledgement === 'string') {
    parts.push(`acknowledgement ${payload.acknowledgement}`);
  }
  if (typeof payload.nextAttemptAt === 'string') {
    parts.push(`next attempt ${new Date(payload.nextAttemptAt).toLocaleTimeString()}`);
  }
  if (typeof payload.providerStatusCode === 'number') {
    parts.push(`provider status ${String(payload.providerStatusCode)}`);
  }

  return parts.length > 0 ? parts.join(' · ') : undefined;
}

export function DeliveryTimeline({
  notification,
  events,
}: {
  notification: NotificationResponse;
  events: readonly NotificationEventResponse[];
}): ReactNode {
  const groups = groupByAttempt(events);

  return (
    <Panel
      title="Delivery history"
      description="Everything that happened, in the order it happened."
    >
      <ol className="divide-y divide-border">
        {groups.map((group) => (
          <li
            key={`${String(group.attemptNumber)}-${group.events[0]?.id ?? ''}`}
            className="px-4 py-3"
          >
            {group.attemptNumber !== null && (
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-subtle">
                Attempt {group.attemptNumber} of {notification.maximumAttempts}
              </p>
            )}
            <ul className="flex flex-col gap-2">
              {group.events.map((event) => {
                const detail = describePayload(event);

                return (
                  <li key={event.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="text-sm text-ink">
                      {eventLabels[event.eventType] ?? event.eventType}
                    </span>
                    <span className="text-xs text-ink-subtle">
                      <Timestamp value={event.occurredAt} />
                    </span>
                    {detail !== undefined && (
                      <span className="font-mono text-xs text-ink-muted">{detail}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ol>

      <div className="border-t border-border px-4 py-3">
        <AcknowledgementStepper notification={notification} />
      </div>
    </Panel>
  );
}

/**
 * The acknowledgement chain, collapsed into one row.
 *
 * A missing read receipt is stated in words rather than left as an empty step,
 * because the obvious reading of a blank "Read" marker is that something went
 * wrong — and the overwhelmingly common cause is that the recipient turned read
 * receipts off, which is not a delivery problem at all.
 */
function AcknowledgementStepper({
  notification,
}: {
  notification: NotificationResponse;
}): ReactNode {
  const steps = [
    { label: 'Accepted', at: notification.createdAt },
    { label: 'Sent', at: notification.sentAt },
    { label: 'Delivered', at: notification.deliveredAt },
    { label: 'Read', at: notification.readAt },
  ];

  return (
    <div className="flex flex-col gap-2">
      <ol className="flex flex-wrap gap-x-6 gap-y-2">
        {steps.map((step) => (
          <li key={step.label} className="flex items-center gap-2 text-sm">
            <span
              aria-hidden="true"
              className={step.at === null ? 'text-ink-subtle' : 'text-positive'}
            >
              {step.at === null ? '○' : '●'}
            </span>
            <span className={step.at === null ? 'text-ink-subtle' : 'text-ink'}>{step.label}</span>
            {step.at !== null && (
              <span className="text-xs text-ink-subtle">
                <Timestamp value={step.at} />
              </span>
            )}
          </li>
        ))}
      </ol>

      {notification.deliveredAt !== null && notification.readAt === null && (
        <p className="text-xs text-ink-subtle">
          No read receipt. The recipient may have read receipts turned off — this does not mean the
          message failed.
        </p>
      )}

      {notification.failureReason !== null && (
        <Alert title={notification.failureCode ?? 'Failed'}>{notification.failureReason}</Alert>
      )}
    </div>
  );
}
