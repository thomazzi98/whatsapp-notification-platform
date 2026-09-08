import { notificationStatuses, providerSessionStatuses } from '@platform/domain';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  ConnectionStatusBadge,
  describeConnectionStatus,
  describeNotificationStatus,
  NotificationStatusBadge,
} from './status';

/** The glyph is decorative, so it is hidden from assistive technology. */
function glyphOf(container: HTMLElement): string {
  return container.querySelector('[aria-hidden="true"]')?.textContent ?? '';
}

describe('how a status is shown', () => {
  it('carries a glyph as well as a colour, for every notification status', () => {
    for (const status of notificationStatuses) {
      const { container, unmount } = render(<NotificationStatusBadge status={status} />);

      // Colour alone excludes anyone reading this printed, in a screenshot, or
      // with the palette they happen to have.
      expect(glyphOf(container)).not.toBe('');
      expect(container.textContent?.replace(glyphOf(container), '').trim()).not.toBe('');
      unmount();
    }
  });

  it('carries a glyph as well as a colour, for every connection status', () => {
    for (const status of providerSessionStatuses) {
      const { container, unmount } = render(<ConnectionStatusBadge status={status} />);

      expect(glyphOf(container)).not.toBe('');
      unmount();
    }
  });

  it('explains what "Sent" means, because the obvious reading is wrong', () => {
    // A caller who reads "Sent" as "arrived" chases the wrong problem.
    expect(describeNotificationStatus('SENT')).toBe(
      'WhatsApp accepted it. Nobody has received it yet.',
    );

    render(<NotificationStatusBadge status="SENT" />);
    expect(screen.getByText('Sent')).toBeVisible();
  });

  it('says a stopped connection keeps its pairing, because the word suggests otherwise', () => {
    expect(describeConnectionStatus('STOPPED')).toMatch(/pairing/i);
  });

  it('has an explanation for every state, not only the ones that go well', () => {
    for (const status of notificationStatuses) {
      expect(describeNotificationStatus(status).length).toBeGreaterThan(0);
    }
    for (const status of providerSessionStatuses) {
      expect(describeConnectionStatus(status).length).toBeGreaterThan(0);
    }
  });
});
