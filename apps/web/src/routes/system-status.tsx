import { type ReactNode } from 'react';

import { useReadiness } from '../api/queries';
import { Alert, Badge, Loading, Panel } from '../components/ui';

export function SystemStatusPage(): ReactNode {
  const readiness = useReadiness();

  return (
    <Panel
      title="System status"
      description="What this API instance reports about the dependencies it needs to work."
    >
      {readiness.isPending && <Loading label="Checking…" />}

      {readiness.isError && (
        <div className="px-4 py-4">
          {/* The screen an operator opens precisely when things are wrong must
              not answer with an empty panel. */}
          <Alert title="Could not reach the API">
            {readiness.error.message} This page keeps trying.
          </Alert>
        </div>
      )}

      {readiness.data !== undefined && (
        <div className="flex flex-col gap-4 px-4 py-4">
          <div className="flex items-center gap-3">
            <Badge
              tone={readiness.data.status === 'ready' ? 'positive' : 'negative'}
              icon={<span aria-hidden="true">{readiness.data.status === 'ready' ? '✓' : '✕'}</span>}
            >
              {readiness.data.status === 'ready' ? 'Ready' : 'Not ready'}
            </Badge>
            <p className="text-sm text-ink-muted">
              {readiness.data.status === 'ready'
                ? 'Accepting and queueing notifications.'
                : 'A dependency this instance needs is unreachable.'}
            </p>
          </div>

          <dl className="divide-y divide-border rounded-panel border border-border">
            {Object.entries(readiness.data.checks).map(([name, check]) => (
              <div
                key={name}
                className="flex flex-wrap items-center justify-between gap-3 px-3 py-2"
              >
                <dt className="text-sm text-ink">{name}</dt>
                <dd className="flex items-center gap-3 text-xs text-ink-muted">
                  <span className="tabular-nums">{check.durationMilliseconds.toFixed(1)} ms</span>
                  {check.reason !== undefined && <span>{check.reason}</span>}
                  <Badge
                    tone={check.status === 'up' ? 'positive' : 'negative'}
                    icon={<span aria-hidden="true">{check.status === 'up' ? '✓' : '✕'}</span>}
                  >
                    {check.status}
                  </Badge>
                </dd>
              </div>
            ))}
          </dl>

          {/*
            Stated rather than implied: an operator looking at a healthy page
            during a WhatsApp outage would otherwise conclude this page is
            lying, when in fact it is answering a narrower question on purpose.
          */}
          <p className="text-xs text-ink-subtle">
            WhatsApp is deliberately not part of this check. Notifications still validate, persist
            and queue while it is unreachable, so taking the API out of service then would hide the
            queue exactly when it needs looking at. A connection's own state is on its page.
          </p>
        </div>
      )}
    </Panel>
  );
}
