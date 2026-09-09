import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

import { pageNameFor, RouteFocus } from './route-focus';

function renderTwoScreens(): void {
  render(
    <MemoryRouter initialEntries={['/applications']}>
      <RouteFocus>
        <Routes>
          <Route
            path="/applications"
            element={
              <main>
                <h1>Applications</h1>
                <Link to="/applications/11111111-1111-4111-8111-111111111111/notifications">
                  Open
                </Link>
              </main>
            }
          />
          <Route
            path="/applications/:applicationId/notifications"
            element={
              <main>
                <h1>Notifications</h1>
              </main>
            }
          />
        </Routes>
      </RouteFocus>
    </MemoryRouter>,
  );
}

describe('navigating between screens', () => {
  it('leaves focus alone on the first render', () => {
    renderTwoScreens();

    // A real page load has already put focus at the top of the document, and
    // stealing it back would interrupt the announcement the browser is making.
    expect(document.body).toHaveFocus();
  });

  it('moves focus to the new screen, rather than leaving it on the link', async () => {
    renderTwoScreens();
    const link = screen.getByRole('link', { name: 'Open' });

    await userEvent.click(link);

    expect(await screen.findByRole('heading', { name: 'Notifications' })).toBeInTheDocument();
    expect(link).not.toHaveFocus();
    // The container wrapping the new screen, so the next Tab lands on that
    // screen's first control instead of continuing from wherever the link was.
    expect(document.activeElement).toHaveAttribute('tabindex', '-1');
    expect(document.activeElement).toContainElement(
      screen.getByRole('heading', { name: 'Notifications' }),
    );
  });

  it('announces the screen it moved to', async () => {
    renderTwoScreens();

    await userEvent.click(screen.getByRole('link', { name: 'Open' }));

    await waitFor(() => {
      expect(screen.getByText('Notifications', { selector: '[aria-live]' })).toBeInTheDocument();
    });
  });
});

describe('naming a screen from its path', () => {
  const identifier = '2f1c9a44-3b8e-4f6d-9b2a-77c1c9e5a001';
  const second = '9a3d1e77-5c2b-4a10-8f33-2b6d4e91c002';

  it.each([
    ['/sign-in', 'Sign in'],
    ['/applications', 'Applications'],
    [`/applications/${identifier}`, 'Overview'],
    [`/applications/${identifier}/notifications`, 'Notifications'],
    [`/applications/${identifier}/notifications/${second}`, 'Notification'],
    [`/applications/${identifier}/send`, 'Send a notification'],
    [`/applications/${identifier}/connections`, 'Connections'],
    [`/applications/${identifier}/connections/${second}`, 'Connection'],
    [`/applications/${identifier}/api-keys`, 'API keys'],
    [`/applications/${identifier}/status`, 'System status'],
  ])('names %s', (pathname, expected) => {
    expect(pageNameFor(pathname)).toBe(expected);
  });

  it('falls back to something true rather than to an empty announcement', () => {
    expect(pageNameFor('/somewhere/nobody/routed')).toBe('Dashboard');
  });
});
