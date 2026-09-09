import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';

/**
 * A single-page application changes the page without telling anybody.
 *
 * A real navigation moves focus to the top of the new document and the screen
 * reader announces it. React Router swaps a subtree and does neither, so a
 * keyboard user's focus stays on the link they just followed — often in a
 * navigation bar belonging to the screen they have left — and a screen reader
 * user hears nothing at all. Both are put back here: focus moves to the new
 * page, and its name is announced politely.
 */
const identifier = '[0-9a-fA-F-]{36}';

const pages: readonly { readonly pattern: RegExp; readonly name: string }[] = [
  { pattern: /^\/sign-in$/, name: 'Sign in' },
  { pattern: /^\/applications$/, name: 'Applications' },
  { pattern: new RegExp(`^/applications/${identifier}$`), name: 'Overview' },
  { pattern: new RegExp(`^/applications/${identifier}/notifications$`), name: 'Notifications' },
  {
    pattern: new RegExp(`^/applications/${identifier}/notifications/${identifier}$`),
    name: 'Notification',
  },
  { pattern: new RegExp(`^/applications/${identifier}/send$`), name: 'Send a notification' },
  { pattern: new RegExp(`^/applications/${identifier}/connections$`), name: 'Connections' },
  {
    pattern: new RegExp(`^/applications/${identifier}/connections/${identifier}$`),
    name: 'Connection',
  },
  { pattern: new RegExp(`^/applications/${identifier}/api-keys$`), name: 'API keys' },
  { pattern: new RegExp(`^/applications/${identifier}/status$`), name: 'System status' },
];

export function pageNameFor(pathname: string): string {
  return pages.find((page) => page.pattern.test(pathname))?.name ?? 'Dashboard';
}

export function RouteFocus({ children }: { readonly children: ReactNode }): ReactNode {
  const { pathname } = useLocation();
  const container = useRef<HTMLDivElement>(null);
  const [announcement, setAnnouncement] = useState('');
  const hasNavigated = useRef(false);

  useEffect(() => {
    // The first render is a real page load, which the browser has already
    // announced. Moving focus again would interrupt it.
    if (!hasNavigated.current) {
      hasNavigated.current = true;
      return;
    }

    container.current?.focus();
    setAnnouncement(pageNameFor(pathname));
  }, [pathname]);

  return (
    <div ref={container} tabIndex={-1} className="outline-none">
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {children}
    </div>
  );
}
