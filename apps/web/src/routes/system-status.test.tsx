import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { apiMock } from '../../testing/api-mock';
import { expectNoAccessibilityViolations, renderScreen } from '../../testing/render';
import { SystemStatusPage } from './system-status';

describe('the system status screen', () => {
  it('says the platform is ready when every dependency answers', async () => {
    apiMock.use(
      http.get('*/ready', () =>
        HttpResponse.json({
          status: 'ready',
          checks: {
            database: { status: 'up', durationMilliseconds: 1.2 },
            queue: { status: 'up', durationMilliseconds: 0.9 },
          },
        }),
      ),
    );

    renderScreen(<SystemStatusPage />);

    expect(await screen.findByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('database')).toBeInTheDocument();
    expect(screen.getByText('queue')).toBeInTheDocument();
  });

  it('shows the reason a dependency gave, which is the point of the screen', async () => {
    apiMock.use(
      http.get('*/ready', () =>
        HttpResponse.json(
          {
            status: 'not_ready',
            checks: {
              database: { status: 'up', durationMilliseconds: 1.1 },
              queue: {
                status: 'down',
                durationMilliseconds: 2.3,
                reason: 'The bootstrap step has not declared: notification.dispatch.',
              },
            },
          },
          { status: 503 },
        ),
      ),
    );

    renderScreen(<SystemStatusPage />);

    // A 503 body is the answer, not a failure — it is where the reason lives.
    expect(await screen.findByText('Not ready')).toBeInTheDocument();
    expect(screen.getByText(/The bootstrap step has not declared/)).toBeInTheDocument();
  });

  it('says so when the API cannot be reached at all', async () => {
    apiMock.use(http.get('*/ready', () => HttpResponse.text('502 Bad Gateway', { status: 502 })));

    renderScreen(<SystemStatusPage />);

    // The screen an operator opens when things are wrong used to render an
    // empty panel in exactly that case.
    expect(await screen.findByText('Could not reach the API')).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    apiMock.use(
      http.get('*/ready', () =>
        HttpResponse.json({
          status: 'ready',
          checks: { database: { status: 'up', durationMilliseconds: 1 } },
        }),
      ),
    );

    const { container } = renderScreen(<SystemStatusPage />);
    await screen.findByText('Ready');

    await expectNoAccessibilityViolations(container);
  });
});
