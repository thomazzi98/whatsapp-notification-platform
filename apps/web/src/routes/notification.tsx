import { type ReactNode } from 'react';
import { Link, useParams } from 'react-router';

import { useCancelNotification, useNotification, useNotificationEvents } from '../api/queries';
import { describeNotificationStatus, NotificationStatusBadge } from '../components/status';
import { DeliveryTimeline } from '../components/timeline';
import { Alert, Button, Loading, Panel, Timestamp } from '../components/ui';

const cancellableStatuses = new Set(['SCHEDULED', 'QUEUED', 'RETRYING']);

export function NotificationPage(): ReactNode {
  const { applicationId = '', notificationId = '' } = useParams();
  const notification = useNotification(applicationId, notificationId);
  const events = useNotificationEvents(applicationId, notificationId);
  const cancel = useCancelNotification(applicationId);

  if (notification.isPending) {
    return <Loading label="Loading notification…" />;
  }

  if (notification.isError) {
    return <Alert title="Could not load this notification">{notification.error.message}</Alert>;
  }

  const record = notification.data;
  const isCancellable = cancellableStatuses.has(record.status);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to=".." relative="path" className="text-sm text-ink-muted hover:text-ink">
            ← Back to notifications
          </Link>
          <h1 className="mt-1 text-lg font-semibold text-ink">Notification</h1>
          <p className="font-mono text-xs text-ink-subtle">{record.id}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <NotificationStatusBadge status={record.status} />
          <p className="max-w-xs text-right text-xs text-ink-muted">
            {describeNotificationStatus(record.status)}
          </p>
        </div>
      </div>

      {/*
        Cancellation is offered only while it can succeed. A notification being
        handed to WhatsApp cannot be recalled, and a button that fails on press
        is worse than no button.
      */}
      {isCancellable && (
        <div>
          <Button
            variant="danger"
            isBusy={cancel.isPending}
            onClick={() => {
              cancel.mutate(notificationId);
            }}
          >
            Cancel this notification
          </Button>
          {cancel.isError && (
            <div className="mt-2">
              <Alert title="Could not cancel it">{cancel.error.message}</Alert>
            </div>
          )}
        </div>
      )}

      <Panel title="Message">
        <dl className="grid gap-4 px-4 py-4 sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-subtle">Recipient</dt>
            <dd className="mt-0.5 font-mono text-sm text-ink">{record.recipient}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-subtle">Attempts</dt>
            <dd className="mt-0.5 text-sm tabular-nums text-ink">
              {record.attemptCount} of {record.maximumAttempts}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-xs uppercase tracking-wide text-ink-subtle">Body</dt>
            <dd className="mt-0.5 whitespace-pre-wrap text-sm text-ink">{record.body}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-subtle">Provider message</dt>
            <dd className="mt-0.5 break-all font-mono text-xs text-ink-muted">
              {record.providerMessageId ?? '—'}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-subtle">Next attempt</dt>
            <dd className="mt-0.5 text-sm text-ink-muted">
              <Timestamp value={record.nextAttemptAt} />
            </dd>
          </div>
        </dl>
      </Panel>

      {events.data !== undefined && <DeliveryTimeline notification={record} events={events.data} />}
    </div>
  );
}
