import { type NotificationEventResponse, type NotificationResponse } from '@platform/contracts';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAccessibilityViolations } from '../../testing/render';
import { DeliveryTimeline } from './timeline';

const baseNotification: NotificationResponse = {
  id: '00000000-0000-7000-8000-000000000001',
  status: 'DELIVERED',
  recipient: '+5511999998888',
  body: 'Your order has shipped.',
  whatsAppSessionId: '00000000-0000-7000-8000-0000000000aa',
  scheduledAt: null,
  attemptCount: 1,
  maximumAttempts: 5,
  nextAttemptAt: null,
  providerMessageId: 'STUB000001',
  sentAt: '2026-09-08T10:00:02.000Z',
  deliveredAt: '2026-09-08T10:00:05.000Z',
  readAt: null,
  failedAt: null,
  failureCode: null,
  failureReason: null,
  metadata: {},
  createdAt: '2026-09-08T10:00:00.000Z',
  updatedAt: '2026-09-08T10:00:05.000Z',
};

function event(
  overrides: Partial<NotificationEventResponse> & { id: string },
): NotificationEventResponse {
  return {
    eventType: 'notification.created',
    fromStatus: null,
    toStatus: 'QUEUED',
    attemptNumber: null,
    payload: {},
    occurredAt: '2026-09-08T10:00:00.000Z',
    ...overrides,
  };
}

describe('the delivery timeline', () => {
  it('groups events by attempt, because that is the unit a person reasons in', () => {
    render(
      <DeliveryTimeline
        notification={{ ...baseNotification, attemptCount: 2, status: 'SENT' }}
        events={[
          event({ id: '1' }),
          event({ id: '2', eventType: 'notification.sent', attemptNumber: 1 }),
          event({
            id: '3',
            eventType: 'notification.retry_scheduled',
            attemptNumber: 1,
            payload: { failureCode: 'provider_timeout' },
          }),
          event({ id: '4', eventType: 'notification.sent', attemptNumber: 2 }),
        ]}
      />,
    );

    expect(screen.getByText('Attempt 1 of 5')).toBeInTheDocument();
    expect(screen.getByText('Attempt 2 of 5')).toBeInTheDocument();
    expect(screen.getByText(/provider_timeout/)).toBeInTheDocument();
  });

  it('says why there is no read receipt, rather than leaving an empty marker', () => {
    render(<DeliveryTimeline notification={baseNotification} events={[event({ id: '1' })]} />);

    // A blank "Read" step reads as something having gone wrong. The
    // overwhelmingly common cause is a recipient who turned receipts off.
    expect(screen.getByText(/The recipient may have read receipts turned off/)).toBeInTheDocument();
  });

  it('says nothing about read receipts before the message is delivered', () => {
    render(
      <DeliveryTimeline
        notification={{ ...baseNotification, status: 'SENT', deliveredAt: null }}
        events={[event({ id: '1' })]}
      />,
    );

    expect(
      screen.queryByText(/The recipient may have read receipts turned off/),
    ).not.toBeInTheDocument();
  });

  it('marks the steps that have happened and leaves the rest plainly unfinished', () => {
    render(<DeliveryTimeline notification={baseNotification} events={[event({ id: '1' })]} />);

    const read = screen.getByText('Read').closest('li');
    const delivered = screen.getByText('Delivered').closest('li');

    expect(read).not.toBeNull();
    expect(delivered).not.toBeNull();
    // Never colour alone: the filled and hollow markers differ in shape too.
    expect(within(delivered as HTMLElement).getByText('●')).toBeInTheDocument();
    expect(within(read as HTMLElement).getByText('○')).toBeInTheDocument();
  });

  it('shows a final failure without asking anyone to expand anything', () => {
    render(
      <DeliveryTimeline
        notification={{
          ...baseNotification,
          status: 'FAILED',
          deliveredAt: null,
          failedAt: '2026-09-08T10:45:00.000Z',
          failureCode: 'recipient_not_on_whatsapp',
          failureReason: 'That number is not on WhatsApp.',
        }}
        events={[event({ id: '1' }), event({ id: '2', eventType: 'notification.failed' })]}
      />,
    );

    expect(screen.getByText('recipient_not_on_whatsapp')).toBeInTheDocument();
    expect(screen.getByText('That number is not on WhatsApp.')).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <DeliveryTimeline notification={baseNotification} events={[event({ id: '1' })]} />,
    );

    await expectNoAccessibilityViolations(container);
  });
});
