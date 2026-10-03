import { type WhatsAppSessionResponse } from '@platform/contracts';
import { type ReactNode } from 'react';

import { Alert, Panel, Timestamp } from './ui';

/**
 * Whether WhatsApp is keeping this connection from sending right now. A pause
 * whose time has passed is one the next send will lift, so it no longer counts.
 */
export function isConnectionPaused(connection: WhatsAppSessionResponse, now = Date.now()): boolean {
  const pausedUntil = connection.sendingPausedUntil;

  return pausedUntil !== null && Date.parse(pausedUntil) > now;
}

/**
 * The warning a person sees first on a restricted connection.
 *
 * The instruction matters more than the fact: the natural reaction to a number
 * that stopped working is to unpair it and scan again, and that does nothing
 * to a restriction on the account except restart it.
 */
export function RestrictionAlert({
  connection,
}: {
  connection: WhatsAppSessionResponse;
}): ReactNode {
  if (!isConnectionPaused(connection)) {
    return null;
  }

  return (
    <Alert tone="caution" title="WhatsApp is restricting this number">
      It cannot message new contacts until <Timestamp value={connection.sendingPausedUntil} />, so
      nothing is sent from this connection until then. Notifications that can wait are held and go
      out afterwards; the rest fail as <code>connection_restricted</code>. Do not restart, unpair or
      pair it again: that does not lift the restriction. It lifts on its own.
    </Alert>
  );
}

function describeTimelock(limits: WhatsAppSessionResponse['accountLimits']): ReactNode {
  const timelock = limits?.reachoutTimelock ?? null;

  if (timelock?.isActive !== true) {
    return 'No restriction reported';
  }
  return (
    <>
      Restricted until <Timestamp value={timelock.endsAt} />
    </>
  );
}

function describeQuota(limits: WhatsAppSessionResponse['accountLimits']): ReactNode {
  const quota = limits?.newChatQuota ?? null;

  if (quota === null || quota.total < 0) {
    return 'No limit reported';
  }

  const usage = `${String(quota.used)} of ${String(quota.total)} used`;
  return quota.status === 'NONE' ? usage : `${usage} — WhatsApp warns: ${quota.status}`;
}

/** The digits of a paired number, as a wa.me link wants them. */
function toChatLink(phoneNumber: string): string {
  return `https://wa.me/${phoneNumber.replaceAll(/\D/g, '')}`;
}

/**
 * What WhatsApp enforces on the account, and the one thing that avoids it:
 * people who write to the number first are not new contacts, so nothing about
 * reaching them is restricted or counted.
 */
export function AccountLimitsPanel({
  connection,
}: {
  connection: WhatsAppSessionResponse;
}): ReactNode {
  const limits = connection.accountLimits;

  return (
    <Panel
      title="WhatsApp limits"
      description="What WhatsApp enforces on this number for starting conversations with people who never wrote to it."
    >
      <dl className="grid gap-4 px-4 py-4 sm:grid-cols-3">
        <div>
          <dt className="text-xs uppercase tracking-wide text-ink-subtle">New contacts</dt>
          <dd className="mt-0.5 text-sm text-ink">{describeTimelock(limits)}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-ink-subtle">
            Monthly messages to people who have not replied
          </dt>
          <dd className="mt-0.5 text-sm text-ink">{describeQuota(limits)}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-ink-subtle">Last checked</dt>
          <dd className="mt-0.5 text-sm text-ink-muted">
            <Timestamp value={limits?.checkedAt ?? null} />
          </dd>
        </div>
      </dl>
      {connection.phoneNumber !== null && (
        <p className="border-t border-border px-4 py-3 text-sm text-ink-muted">
          People who write to this number first are not new contacts, and nothing above applies to
          them. Ask the people you notify to send it a message once:{' '}
          <a className="font-mono text-ink underline" href={toChatLink(connection.phoneNumber)}>
            {toChatLink(connection.phoneNumber)}
          </a>
        </p>
      )}
    </Panel>
  );
}
