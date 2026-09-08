import { type FormEvent, type ReactNode, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { fieldError, isFieldLevel } from '../api/client';
import { useConnections, useCreateConnection } from '../api/queries';
import { ConnectionStatusBadge, describeConnectionStatus } from '../components/status';
import { Alert, Button, EmptyState, Field, Loading, Panel, TextInput } from '../components/ui';

export function ConnectionsPage(): ReactNode {
  const { applicationId = '' } = useParams();
  const navigate = useNavigate();
  const connections = useConnections(applicationId);
  const connectionCreation = useCreateConnection(applicationId);
  const failure = connectionCreation.error;
  const [displayName, setDisplayName] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    connectionCreation.mutate(
      { displayName },
      {
        onSuccess: (connection) => {
          setIsCreating(false);
          setDisplayName('');
          // The connection is created waiting for a scan, so the only useful
          // next screen is the one with the code on it.
          void navigate(connection.id);
        },
      },
    );
  };

  return (
    <Panel
      title="WhatsApp connections"
      description="Each connection is one WhatsApp account this application sends from."
      actions={
        <Button
          variant="primary"
          onClick={() => {
            setIsCreating(!isCreating);
          }}
        >
          {isCreating ? 'Cancel' : 'Connect an account'}
        </Button>
      }
    >
      {isCreating && (
        <form className="flex flex-col gap-4 border-b border-border px-4 py-4" onSubmit={submit}>
          <Field
            error={fieldError(failure, 'displayName')}
            label="Name"
            hint="For you, not for WhatsApp. Something like “Support line” or “Order updates”."
          >
            {(fieldProps) => (
              <TextInput
                {...fieldProps}
                value={displayName}
                required
                autoFocus
                onChange={(event) => {
                  setDisplayName(event.target.value);
                }}
              />
            )}
          </Field>
          <Alert tone="caution" title="Use a dedicated number">
            This is an unofficial WhatsApp integration. The number can be banned at any time, so do
            not pair a personal account.
          </Alert>
          {connectionCreation.isError && !isFieldLevel(failure) && (
            <Alert title="Could not create the connection">
              {connectionCreation.error.message}
            </Alert>
          )}
          <div>
            <Button type="submit" variant="primary" isBusy={connectionCreation.isPending}>
              Create and show the code
            </Button>
          </div>
        </form>
      )}

      {connections.isPending && <Loading label="Loading connections…" />}

      {connections.isError && (
        <div className="px-4 py-4">
          <Alert title="Could not load connections">{connections.error.message}</Alert>
        </div>
      )}

      {connections.data?.length === 0 && (
        <EmptyState
          title="Nothing connected yet"
          description="Connect a WhatsApp account to start delivering notifications. Anything sent before then simply waits."
        />
      )}

      {connections.data !== undefined && connections.data.length > 0 && (
        <ul className="divide-y divide-border">
          {connections.data.map((connection) => (
            <li key={connection.id}>
              <Link
                to={connection.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-surface-sunken"
              >
                <div>
                  <p className="text-sm font-medium text-ink">{connection.displayName}</p>
                  <p className="text-xs text-ink-subtle">
                    {connection.phoneNumber ?? describeConnectionStatus(connection.status)}
                  </p>
                </div>
                <ConnectionStatusBadge status={connection.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
