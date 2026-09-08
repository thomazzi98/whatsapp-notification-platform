import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { apiMock } from '../../testing/api-mock';
import { expectNoAccessibilityViolations, renderScreen } from '../../testing/render';
import { ApiKeysPage } from './api-keys';

const APPLICATION_ID = '00000000-0000-7000-8000-000000000001';

function renderApiKeys(): ReturnType<typeof renderScreen> {
  return renderScreen(<ApiKeysPage />, {
    path: `/applications/${APPLICATION_ID}/api-keys`,
    pattern: '/applications/:applicationId/api-keys',
  });
}

function listReturns(keys: unknown[]): void {
  apiMock.use(
    http.get(`*/dashboard/applications/${APPLICATION_ID}/api-keys`, () =>
      HttpResponse.json({ data: keys }),
    ),
  );
}

describe('API keys', () => {
  it('offers only the scopes a route actually checks', async () => {
    listReturns([]);
    renderApiKeys();

    expect(await screen.findByLabelText(/notifications:write/)).toBeInTheDocument();
    expect(screen.getByLabelText(/notifications:read/)).toBeInTheDocument();
    // Templates have a table and no endpoint, and connection state is
    // deliberately a dashboard concern. A checkbox granting nothing is worse
    // than an absent one.
    expect(screen.queryByLabelText(/templates:read/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/sessions:read/)).not.toBeInTheDocument();
  });

  it('refuses to create a key that could authenticate and do nothing', async () => {
    listReturns([]);
    renderApiKeys();

    await userEvent.click(await screen.findByLabelText(/notifications:write/));
    await userEvent.click(screen.getByLabelText(/notifications:read/));

    expect(screen.getByRole('button', { name: 'Create key' })).toBeDisabled();
  });

  it('shows the key once, and says that is the only time', async () => {
    listReturns([]);
    apiMock.use(
      http.post(`*/dashboard/applications/${APPLICATION_ID}/api-keys`, () =>
        HttpResponse.json(
          {
            id: '00000000-0000-7000-8000-00000000000a',
            name: 'orders-service',
            environment: 'test',
            scopes: ['notifications:write', 'notifications:read'],
            displayPrefix: 'wnp_test_abcdefghijkl',
            lastFour: 'wxyz',
            lastUsedAt: null,
            revokedAt: null,
            createdAt: '2026-09-08T10:00:00.000Z',
            plaintextKey: 'wnp_test_abcdefghijklMNOPQRSTUVWXYZ0123456789abcd',
          },
          { status: 201 },
        ),
      ),
    );

    renderApiKeys();
    await userEvent.type(await screen.findByLabelText('Name'), 'orders-service');
    await userEvent.click(screen.getByRole('button', { name: 'Create key' }));

    expect(await screen.findByText('Copy this key now')).toBeInTheDocument();
    expect(
      screen.getByText('wnp_test_abcdefghijklMNOPQRSTUVWXYZ0123456789abcd'),
    ).toBeInTheDocument();
  });

  it('shows a prefix rather than a key once the notice is dismissed', async () => {
    listReturns([
      {
        id: '00000000-0000-7000-8000-00000000000a',
        name: 'orders-service',
        environment: 'live',
        scopes: ['notifications:write'],
        displayPrefix: 'wnp_live_abcdefghijkl',
        lastFour: 'wxyz',
        lastUsedAt: null,
        revokedAt: null,
        createdAt: '2026-09-08T10:00:00.000Z',
      },
    ]);

    renderApiKeys();
    const row = await screen.findByText('orders-service');

    // Enough to recognise a key at a glance, and useless for authenticating.
    expect(screen.getByText(/wnp_live_abcdefghijkl…wxyz/)).toBeInTheDocument();
    expect(row).toBeInTheDocument();
  });

  it('says a revoked key is revoked rather than removing it from the list', async () => {
    listReturns([
      {
        id: '00000000-0000-7000-8000-00000000000b',
        name: 'retired-service',
        environment: 'live',
        scopes: ['notifications:write'],
        displayPrefix: 'wnp_live_zyxwvutsrqpo',
        lastFour: 'abcd',
        lastUsedAt: null,
        revokedAt: '2026-09-08T11:00:00.000Z',
        createdAt: '2026-09-08T10:00:00.000Z',
      },
    ]);

    renderApiKeys();
    const name = await screen.findByText('retired-service');
    const listItem = name.closest('li');

    expect(listItem).not.toBeNull();
    expect(within(listItem as HTMLElement).getByText('Revoked')).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    listReturns([]);
    const { container } = renderApiKeys();
    await screen.findByLabelText(/notifications:write/);

    await expectNoAccessibilityViolations(container);
  });
});
