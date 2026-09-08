import { type ReactNode, useState } from 'react';
import { Link, useParams } from 'react-router';

import { type NotificationFilters, useNotifications } from '../api/queries';
import { notificationStatusOrder, NotificationStatusBadge } from '../components/status';
import {
  Alert,
  Button,
  EmptyState,
  Field,
  Loading,
  Panel,
  Select,
  TextInput,
  Timestamp,
} from '../components/ui';

export function NotificationsPage(): ReactNode {
  const { applicationId = '' } = useParams();
  const [filters, setFilters] = useState<NotificationFilters>({});
  // Cursors are opaque and signed, so paging forward means remembering where
  // each page started rather than computing an offset.
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const notifications = useNotifications(applicationId, filters);

  const applyFilter = (change: Partial<NotificationFilters>): void => {
    // Changing a filter starts a new result set, so the old cursor is
    // meaningless: keeping it would page into a list that no longer exists.
    setCursorHistory([]);
    setFilters((current) => ({ ...current, ...change, cursor: undefined }));
  };

  return (
    <div className="flex flex-col gap-4">
      <Panel title="Filters">
        <div className="grid gap-4 px-4 py-4 sm:grid-cols-2">
          <Field label="Status">
            {(fieldProps) => (
              <Select
                {...fieldProps}
                value={filters.status ?? ''}
                onChange={(event) => {
                  const value = event.target.value;
                  applyFilter({
                    status: value === '' ? undefined : (value as NotificationFilters['status']),
                  });
                }}
              >
                <option value="">Any status</option>
                {notificationStatusOrder.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field label="Recipient" hint="An exact number in international format.">
            {(fieldProps) => (
              <TextInput
                {...fieldProps}
                placeholder="+5511999998888"
                defaultValue={filters.recipient ?? ''}
                onBlur={(event) => {
                  applyFilter({
                    recipient: event.target.value === '' ? undefined : event.target.value,
                  });
                }}
              />
            )}
          </Field>
        </div>
      </Panel>

      <Panel title="Notifications">
        {notifications.isPending && <Loading label="Loading notifications…" />}

        {notifications.isError && (
          <div className="px-4 py-4">
            <Alert title="Could not load notifications">{notifications.error.message}</Alert>
          </div>
        )}

        {notifications.data?.data.length === 0 && (
          <EmptyState
            title="Nothing matches"
            description="No notifications match these filters yet."
          />
        )}

        {notifications.data !== undefined && notifications.data.data.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-2xl border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wide text-ink-subtle">
                  <th scope="col" className="px-4 py-2 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Recipient
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Message
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Attempts
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Created
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {notifications.data.data.map((notification) => (
                  <tr key={notification.id} className="hover:bg-surface-sunken">
                    <td className="px-4 py-2">
                      <NotificationStatusBadge status={notification.status} />
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">{notification.recipient}</td>
                    <td className="max-w-md px-4 py-2">
                      <Link
                        className="block truncate text-accent underline underline-offset-2"
                        to={notification.id}
                      >
                        {notification.body}
                      </Link>
                    </td>
                    <td className="px-4 py-2 tabular-nums text-ink-muted">
                      {notification.attemptCount} / {notification.maximumAttempts}
                    </td>
                    <td className="px-4 py-2 text-xs text-ink-muted">
                      <Timestamp value={notification.createdAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
          <Button
            disabled={cursorHistory.length === 0}
            onClick={() => {
              const previous = cursorHistory.at(-1);
              setCursorHistory(cursorHistory.slice(0, -1));
              setFilters((current) => ({
                ...current,
                cursor: cursorHistory.length > 1 ? previous : undefined,
              }));
            }}
          >
            Previous
          </Button>
          <Button
            disabled={notifications.data?.nextCursor === null}
            onClick={() => {
              const next = notifications.data?.nextCursor;
              if (next === null || next === undefined) {
                return;
              }
              setCursorHistory([...cursorHistory, filters.cursor ?? '']);
              setFilters((current) => ({ ...current, cursor: next }));
            }}
          >
            Next
          </Button>
        </div>
      </Panel>
    </div>
  );
}
