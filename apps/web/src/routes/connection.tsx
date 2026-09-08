import { type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { useConnection, useConnectionAction, useDeleteConnection } from '../api/queries';
import { ConnectionActions, QrPanel } from '../components/qr-panel';
import { ConnectionStatusBadge, describeConnectionStatus } from '../components/status';
import { Alert, Button, Loading, Panel, Timestamp } from '../components/ui';

export function ConnectionPage(): ReactNode {
  const { applicationId = '', connectionId = '' } = useParams();
  const navigate = useNavigate();
  const connection = useConnection(applicationId, connectionId);
  const act = useConnectionAction(applicationId, connectionId);
  const remove = useDeleteConnection(applicationId);

  if (connection.isPending) {
    return <Loading label="Loading connection…" />;
  }

  if (connection.isError) {
    return <Alert title="Could not load this connection">{connection.error.message}</Alert>;
  }

  const record = connection.data;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to=".." relative="path" className="text-sm text-ink-muted hover:text-ink">
            ← Back to connections
          </Link>
          <h1 className="mt-1 text-lg font-semibold text-ink">{record.displayName}</h1>
          <p className="text-sm text-ink-muted">{describeConnectionStatus(record.status)}</p>
        </div>
        <ConnectionStatusBadge status={record.status} />
      </div>

      <QrPanel applicationId={applicationId} connection={record} />

      {record.lastError !== null && (
        <Alert title="The provider reported a problem">{record.lastError}</Alert>
      )}

      <Panel title="Details">
        <dl className="grid gap-4 px-4 py-4 sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-subtle">Paired number</dt>
            <dd className="mt-0.5 font-mono text-sm text-ink">{record.phoneNumber ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-subtle">Account name</dt>
            <dd className="mt-0.5 text-sm text-ink">{record.pushName ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-subtle">Status changed</dt>
            <dd className="mt-0.5 text-sm text-ink-muted">
              <Timestamp value={record.lastStatusAt} />
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-subtle">Created</dt>
            <dd className="mt-0.5 text-sm text-ink-muted">
              <Timestamp value={record.createdAt} />
            </dd>
          </div>
        </dl>
      </Panel>

      <Panel title="Actions">
        <div className="flex flex-col gap-4 px-4 py-4">
          <div>
            <ConnectionActions
              connection={record}
              isBusy={act.isPending}
              onStart={() => {
                act.mutate('start');
              }}
              onStop={() => {
                act.mutate('stop');
              }}
              onLogout={() => {
                act.mutate('logout');
              }}
            />
            <p className="mt-2 text-xs text-ink-subtle">
              Stopping is reversible — starting again resumes the same pairing. Unpairing is not:
              somebody has to scan a new code.
            </p>
          </div>

          {act.isError && <Alert title="That action failed">{act.error.message}</Alert>}

          <div className="border-t border-border pt-4">
            <Button
              variant="danger"
              isBusy={remove.isPending}
              onClick={() => {
                remove.mutate(connectionId, {
                  onSuccess: () => {
                    void navigate('..', { relative: 'path' });
                  },
                });
              }}
            >
              Delete this connection
            </Button>
            <p className="mt-2 text-xs text-ink-subtle">
              Removes it from the provider and from this application. Notifications already queued
              against it cannot be sent afterwards.
            </p>
            {remove.isError && (
              <div className="mt-2">
                <Alert title="Could not delete it">{remove.error.message}</Alert>
              </div>
            )}
          </div>
        </div>
      </Panel>
    </div>
  );
}
