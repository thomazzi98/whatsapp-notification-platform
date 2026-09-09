import { type ApiKeyCreationResponse } from '@platform/contracts';
import { type ApiKeyScope } from '@platform/domain';
import { type FormEvent, type ReactNode, useState } from 'react';
import { useParams } from 'react-router';

import { useApiKeys, useCreateApiKey, useRevokeApiKey } from '../api/queries';
import { availableScopes, describeScope, suggestedScopes } from '../components/scopes';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Field,
  Loading,
  Panel,
  TextInput,
  Timestamp,
} from '../components/ui';

/**
 * The one moment a usable credential is on screen.
 *
 * It is shown once and never recoverable, which is stated plainly rather than
 * discovered later: the alternative is storing a key the platform could read
 * back, and a database dump would then be a set of working credentials.
 */
function CreatedKeyNotice({
  created,
  onDismiss,
}: {
  created: ApiKeyCreationResponse;
  onDismiss: () => void;
}): ReactNode {
  return (
    <div
      // The one moment a usable credential exists, announced. It appears above
      // a form the reader has just submitted, so without a live region a
      // screen-reader user is never told it arrived at all.
      role="status"
      aria-live="polite"
      className="border-b border-border bg-accent-subtle px-4 py-4"
    >
      <p className="text-sm font-semibold text-ink">Copy this key now</p>
      <p className="mt-0.5 text-sm text-ink-muted">
        This is the only time it can be read. The platform stores a hash, so it cannot show it again
        — losing it means creating a new one.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-control border border-border bg-surface-raised px-3 py-2 font-mono text-xs text-ink">
        {created.plaintextKey}
      </pre>
      <div className="mt-3 flex gap-2">
        <Button
          variant="primary"
          onClick={() => {
            void navigator.clipboard.writeText(created.plaintextKey);
          }}
        >
          Copy
        </Button>
        <Button onClick={onDismiss}>I have saved it</Button>
      </div>
    </div>
  );
}

export function ApiKeysPage(): ReactNode {
  const { applicationId = '' } = useParams();
  const apiKeys = useApiKeys(applicationId);
  const apiKeyCreation = useCreateApiKey(applicationId);
  const revokeApiKey = useRevokeApiKey(applicationId);
  const [created, setCreated] = useState<ApiKeyCreationResponse | undefined>(undefined);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiKeyScope[]>([...suggestedScopes]);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    apiKeyCreation.mutate(
      { name, scopes },
      {
        onSuccess: (response) => {
          setCreated(response);
          setName('');
        },
      },
    );
  };

  return (
    <Panel
      title="API keys"
      description="A key authenticates one application. It cannot reach any other."
    >
      {created !== undefined && (
        <CreatedKeyNotice
          created={created}
          onDismiss={() => {
            setCreated(undefined);
          }}
        />
      )}

      <form className="flex flex-col gap-4 border-b border-border px-4 py-4" onSubmit={submit}>
        <Field label="Name" hint="What will use this key — a service name, not a person's name.">
          {(fieldProps) => (
            <TextInput
              {...fieldProps}
              value={name}
              required
              placeholder="orders-service"
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          )}
        </Field>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-ink">Scopes</legend>
          <p className="text-xs text-ink-subtle">
            A key with no scopes could authenticate but do nothing, so at least one is required.
          </p>
          {availableScopes.map((scope) => (
            <label key={scope} className="flex items-start gap-2 text-sm text-ink">
              <input
                className="mt-1"
                type="checkbox"
                checked={scopes.includes(scope)}
                onChange={(event) => {
                  setScopes(
                    event.target.checked
                      ? [...scopes, scope]
                      : scopes.filter((current) => current !== scope),
                  );
                }}
              />
              <span>
                <span className="font-mono text-xs">{scope}</span>
                <span className="block text-xs text-ink-subtle">{describeScope(scope)}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {apiKeyCreation.isError && (
          <Alert title="Could not create the key">{apiKeyCreation.error.message}</Alert>
        )}

        <div>
          <Button
            type="submit"
            variant="primary"
            isBusy={apiKeyCreation.isPending}
            disabled={scopes.length === 0}
          >
            Create key
          </Button>
        </div>
      </form>

      {apiKeys.isPending && <Loading label="Loading keys…" />}

      {apiKeys.data?.length === 0 && (
        <EmptyState
          title="No keys yet"
          description="Create one so an application can send notifications."
        />
      )}

      {apiKeys.data !== undefined && apiKeys.data.length > 0 && (
        <ul className="divide-y divide-border">
          {apiKeys.data.map((apiKey) => (
            <li
              key={apiKey.id}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">{apiKey.name}</p>
                <p className="font-mono text-xs text-ink-subtle">
                  {apiKey.displayPrefix}…{apiKey.lastFour}
                </p>
                <p className="mt-1 text-xs text-ink-subtle">
                  Created <Timestamp value={apiKey.createdAt} /> · Last used{' '}
                  {apiKey.lastUsedAt === null ? 'never' : <Timestamp value={apiKey.lastUsedAt} />}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {apiKey.revokedAt === null ? (
                  <Button
                    variant="danger"
                    isBusy={revokeApiKey.isPending}
                    onClick={() => {
                      revokeApiKey.mutate(apiKey.id);
                    }}
                  >
                    Revoke
                  </Button>
                ) : (
                  <Badge tone="neutral" icon={<span aria-hidden="true">⊘</span>}>
                    Revoked
                  </Badge>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
