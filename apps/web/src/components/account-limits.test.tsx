import { type WhatsAppSessionResponse } from '@platform/contracts';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAccessibilityViolations, renderScreen } from '../../testing/render';
import { AccountLimitsPanel, isConnectionPaused, RestrictionAlert } from './account-limits';

const inTwoHours = new Date(Date.now() + 2 * 3_600_000).toISOString();

const connection: WhatsAppSessionResponse = {
  id: '00000000-0000-7000-8000-0000000000aa',
  displayName: 'Support line',
  status: 'WORKING',
  phoneNumber: '+5511999990000',
  pushName: 'Support',
  lastError: null,
  sendingPausedUntil: null,
  sendingPausedReason: null,
  accountLimits: {
    reachoutTimelock: null,
    newChatQuota: null,
    checkedAt: '2026-10-03T10:00:00.000Z',
  },
  lastStatusAt: '2026-10-03T10:00:00.000Z',
  createdAt: '2026-10-01T10:00:00.000Z',
};

const restricted: WhatsAppSessionResponse = {
  ...connection,
  sendingPausedUntil: inTwoHours,
  sendingPausedReason: 'REACHOUT_TIMELOCK',
  accountLimits: {
    reachoutTimelock: { isActive: true, endsAt: inTwoHours, enforcementType: 'DEFAULT' },
    newChatQuota: {
      status: 'SECOND_WARNING',
      total: 100,
      used: 95,
      cycleEndsAt: '2026-10-31T23:59:59.000Z',
    },
    checkedAt: '2026-10-03T10:00:00.000Z',
  },
};

describe('the restriction warning', () => {
  it('tells the operator not to re-pair a number WhatsApp is restricting', () => {
    renderScreen(<RestrictionAlert connection={restricted} />);

    expect(screen.getByText('WhatsApp is restricting this number')).toBeInTheDocument();
    // The natural reaction to a number that stopped working, and the wrong one.
    expect(screen.getByText(/Do not restart, unpair or pair it again/)).toBeInTheDocument();
  });

  it('says nothing about a connection WhatsApp is not restricting', () => {
    renderScreen(<RestrictionAlert connection={connection} />);

    expect(screen.queryByText('WhatsApp is restricting this number')).not.toBeInTheDocument();
  });

  it('stops warning once the pause has run out', () => {
    const lapsed = { ...restricted, sendingPausedUntil: '2026-01-01T00:00:00.000Z' };

    expect(isConnectionPaused(lapsed)).toBe(false);
  });
});

describe('the limits panel', () => {
  it('reports the timelock and how much of the quota is used', () => {
    renderScreen(<AccountLimitsPanel connection={restricted} />);

    expect(screen.getByText(/Restricted until/)).toBeInTheDocument();
    expect(screen.getByText('95 of 100 used — WhatsApp warns: SECOND_WARNING')).toBeInTheDocument();
  });

  it('reports nothing in force on an account WhatsApp has said nothing about', () => {
    renderScreen(<AccountLimitsPanel connection={connection} />);

    expect(screen.getByText('No restriction reported')).toBeInTheDocument();
    expect(screen.getByText('No limit reported')).toBeInTheDocument();
  });

  it('offers the link that makes people write first, which avoids every limit', () => {
    renderScreen(<AccountLimitsPanel connection={connection} />);

    expect(screen.getByRole('link', { name: 'https://wa.me/5511999990000' })).toHaveAttribute(
      'href',
      'https://wa.me/5511999990000',
    );
  });

  it('is labelled for assistive technology', async () => {
    const { container } = renderScreen(
      <>
        <RestrictionAlert connection={restricted} />
        <AccountLimitsPanel connection={restricted} />
      </>,
    );

    await expectNoAccessibilityViolations(container);
  });
});
