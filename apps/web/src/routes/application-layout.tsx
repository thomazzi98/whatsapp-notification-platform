import { type ReactNode } from 'react';
import { Link, NavLink, Outlet, useParams } from 'react-router';

import { useApplication, useLogout } from '../api/queries';
import { Alert, Loading } from '../components/ui';

const sections = [
  { to: '', label: 'Overview', isEnd: true },
  { to: 'notifications', label: 'Notifications', isEnd: false },
  { to: 'send', label: 'Send', isEnd: false },
  { to: 'connections', label: 'Connections', isEnd: false },
  { to: 'api-keys', label: 'API keys', isEnd: false },
  { to: 'status', label: 'System status', isEnd: false },
];

export function ApplicationLayout(): ReactNode {
  const { applicationId = '' } = useParams();
  const application = useApplication(applicationId);
  const logout = useLogout();

  return (
    <div className="min-h-dvh">
      <header className="border-b border-border bg-surface-raised">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-baseline gap-3">
            <Link to="/applications" className="text-sm text-ink-muted hover:text-ink">
              Applications
            </Link>
            <span aria-hidden="true" className="text-ink-subtle">
              /
            </span>
            <span className="text-sm font-semibold text-ink">
              {application.data?.name ?? 'Loading…'}
            </span>
          </div>
          <button
            type="button"
            className="text-sm text-ink-muted hover:text-ink"
            onClick={() => {
              logout.mutate();
            }}
          >
            Sign out
          </button>
        </div>

        <nav aria-label="Application sections" className="mx-auto w-full max-w-6xl px-4">
          <ul className="flex flex-wrap gap-1">
            {sections.map((section) => (
              <li key={section.label}>
                <NavLink
                  to={section.to}
                  end={section.isEnd}
                  className={({ isActive }) =>
                    `-mb-px inline-block border-b-2 px-3 py-2 text-sm ${
                      isActive
                        ? 'border-accent font-medium text-ink'
                        : 'border-transparent text-ink-muted hover:text-ink'
                    }`
                  }
                >
                  {section.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 py-6">
        {application.isPending && <Loading label="Loading application…" />}
        {application.isError && (
          <Alert title="Could not load this application">{application.error.message}</Alert>
        )}
        {application.data !== undefined && <Outlet />}
      </main>
    </div>
  );
}
