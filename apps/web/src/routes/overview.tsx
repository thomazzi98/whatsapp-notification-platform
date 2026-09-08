import { type ReactNode } from 'react';
import { Link, useParams } from 'react-router';

import { useConnections, useNotifications } from '../api/queries';
import { ConnectionStatusBadge } from '../components/status';
import { NotificationStatusBadge } from '../components/status';
import { Alert, Button, EmptyState, Loading, Panel, Timestamp } from '../components/ui';

export function OverviewPage(): ReactNode {
  const { applicationId = '' } = useParams();
  const connections = useConnections(applicationId);
  const recent = useNotifications(applicationId, {});

  const hasConnection = connections.data !== undefined && connections.data.length > 0;
  const isConnected = connections.data?.some((connection) => connection.status === 'WORKING');

  return (
    <div className="flex flex-col gap-6">
      {/*
        The first thing anyone needs to know is whether this application can
        send at all. Everything else on the page is history.
      */}
      {connections.data !== undefined && !isConnected && (
        <Alert tone="caution" title="No connected WhatsApp account">
          {hasConnection
            ? 'A connection exists but is not paired. Notifications will queue until it is.'
            : 'Connect a WhatsApp account before sending. Notifications created now will queue.'}{' '}
          <Link className="font-medium underline underline-offset-2" to="connections">
            Go to connections
          </Link>
        </Alert>
      )}

      <Panel
        title="WhatsApp connections"
        actions={
          <Link to="connections">
            <Button>Manage</Button>
          </Link>
        }
      >
        {connections.isPending && <Loading label="Loading connections…" />}
        {connections.data?.length === 0 && (
          <EmptyState
            title="Nothing connected"
            description="A connection is one WhatsApp account this application sends from."
          />
        )}
        {connections.data !== undefined && connections.data.length > 0 && (
          <ul className="divide-y divide-border">
            {connections.data.map((connection) => (
              <li
                key={connection.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div>
                  <p className="text-sm font-medium text-ink">{connection.displayName}</p>
                  <p className="text-xs text-ink-subtle">
                    {connection.phoneNumber ?? 'Not paired yet'}
                  </p>
                </div>
                <ConnectionStatusBadge status={connection.status} />
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Recent notifications"
        actions={
          <Link to="notifications">
            <Button>See all</Button>
          </Link>
        }
      >
        {recent.isPending && <Loading label="Loading notifications…" />}
        {recent.data?.data.length === 0 && (
          <EmptyState
            title="Nothing sent yet"
            description="Notifications appear here the moment the API accepts them."
            action={
              <Link to="send">
                <Button variant="primary">Send one</Button>
              </Link>
            }
          />
        )}
        {recent.data !== undefined && recent.data.data.length > 0 && (
          <ul className="divide-y divide-border">
            {recent.data.data.slice(0, 8).map((notification) => (
              <li key={notification.id}>
                <Link
                  to={`notifications/${notification.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-surface-sunken"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-ink">{notification.body}</p>
                    <p className="text-xs text-ink-subtle">
                      {notification.recipient} · <Timestamp value={notification.createdAt} />
                    </p>
                  </div>
                  <NotificationStatusBadge status={notification.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
