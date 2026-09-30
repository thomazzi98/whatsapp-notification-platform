import { type NotificationResponse } from '@platform/contracts';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { apiMock } from '../../testing/api-mock';
import { expectNoAccessibilityViolations, renderScreen } from '../../testing/render';
import { NotificationsPage } from './notifications';

const APPLICATION_ID = '00000000-0000-7000-8000-000000000001';
const LIST_URL = `*/dashboard/applications/${APPLICATION_ID}/notifications`;

function notification(id: string, status: NotificationResponse['status']): NotificationResponse {
  return {
    id: `00000000-0000-7000-8000-00000000001${id}`,
    status,
    recipient: '+5511999990000',
    body: `Order ${id} shipped`,
    whatsAppSessionId: '00000000-0000-7000-8000-000000000002',
    scheduledAt: null,
    attemptCount: 0,
    maximumAttempts: 5,
    nextAttemptAt: null,
    providerMessageId: null,
    sentAt: null,
    deliveredAt: null,
    readAt: null,
    failedAt: null,
    failureCode: status === 'RETRYING' ? 'session_not_ready' : null,
    failureReason: null,
    metadata: {},
    createdAt: '2026-09-29T20:51:57.000Z',
    updatedAt: '2026-09-29T20:51:57.000Z',
  };
}

function listReturns(notifications: NotificationResponse[]): void {
  apiMock.use(
    http.get(LIST_URL, () => HttpResponse.json({ data: notifications, nextCursor: null })),
  );
}

function renderNotifications(): ReturnType<typeof renderScreen> {
  return renderScreen(<NotificationsPage />, {
    path: `/applications/${APPLICATION_ID}/notifications`,
    pattern: '/applications/:applicationId/notifications',
  });
}

describe('notifications waiting behind a connection that cannot send', () => {
  it('offers to cancel them when the list shows some', async () => {
    listReturns([notification('1', 'RETRYING'), notification('2', 'RETRYING')]);
    renderNotifications();

    expect(
      await screen.findByRole('button', { name: 'Cancel everything waiting' }),
    ).toBeInTheDocument();
  });

  it('does not offer it when nothing on the page is waiting', async () => {
    listReturns([notification('1', 'DELIVERED'), notification('2', 'FAILED')]);
    renderNotifications();

    expect(await screen.findByText('Order 1 shipped')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Cancel everything waiting' }),
    ).not.toBeInTheDocument();
  });

  it('asks once, cancels across the whole application, and says how many', async () => {
    listReturns([notification('1', 'RETRYING'), notification('2', 'QUEUED')]);
    const received: unknown[] = [];
    apiMock.use(
      http.post(`${LIST_URL}/cancel-waiting`, async ({ request }) => {
        received.push(await request.json());
        listReturns([notification('1', 'CANCELLED'), notification('2', 'CANCELLED')]);

        return HttpResponse.json({ cancelledCount: 2 });
      }),
    );
    renderNotifications();

    await userEvent.click(await screen.findByRole('button', { name: 'Cancel everything waiting' }));
    // Irreversible and reaching rows the person is not looking at, so it asks.
    expect(received).toStrictEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Yes, cancel them' }));

    expect(
      await screen.findByText('Cancelled 2 notifications. None of them will be sent.'),
    ).toBeInTheDocument();
    expect(received).toStrictEqual([{}]);
  });

  it('can be put down without cancelling anything', async () => {
    listReturns([notification('1', 'RETRYING')]);
    renderNotifications();

    await userEvent.click(await screen.findByRole('button', { name: 'Cancel everything waiting' }));
    await userEvent.click(screen.getByRole('button', { name: 'Keep them' }));

    expect(screen.getByRole('button', { name: 'Cancel everything waiting' })).toBeInTheDocument();
  });

  it('has no accessibility violations while asking', async () => {
    listReturns([notification('1', 'RETRYING')]);
    const { container } = renderNotifications();

    await userEvent.click(await screen.findByRole('button', { name: 'Cancel everything waiting' }));

    await expectNoAccessibilityViolations(container);
  });
});
