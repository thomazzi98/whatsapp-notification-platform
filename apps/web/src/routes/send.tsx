import { type FormEvent, type ReactNode, useState } from 'react';
import { useNavigate, useParams } from 'react-router';

import { useConnections, useSendNotification } from '../api/queries';
import { Alert, Button, Field, Panel, TextArea, TextInput } from '../components/ui';

/**
 * The equivalent request, updated as the form is filled in.
 *
 * The key is a placeholder, never a real one: this is a snippet meant to be
 * copied into a terminal or a ticket, and putting a live credential on screen
 * for that is how keys end up in chat logs.
 */
function buildCurlSnippet(recipient: string, body: string): string {
  const payload = JSON.stringify({ recipient, body }, null, 2)
    .split('\n')
    .map((line, index) => (index === 0 ? line : `        ${line}`))
    .join('\n');

  return [
    'curl -X POST http://127.0.0.1:3100/v1/notifications \\',
    '  -H "Authorization: Bearer $WNP_API_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    '  -H "Idempotency-Key: $(uuidgen)" \\',
    `  -d '${payload}'`,
  ].join('\n');
}

export function SendPage(): ReactNode {
  const { applicationId = '' } = useParams();
  const navigate = useNavigate();
  const connections = useConnections(applicationId);
  const send = useSendNotification(applicationId);
  const [recipient, setRecipient] = useState('');
  const [body, setBody] = useState('');

  const isConnected = connections.data?.some((connection) => connection.status === 'WORKING');

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    send.mutate(
      { recipient, body, metadata: {} },
      {
        onSuccess: (notification) => {
          // Straight to the delivery page rather than a success message: the
          // API accepted it, which is not the same as anyone receiving it, and
          // the honest thing is to show what actually happens next.
          void navigate(`../notifications/${notification.id}`, { relative: 'path' });
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-6">
      {connections.data !== undefined && isConnected !== true && (
        <Alert tone="caution" title="No connected WhatsApp account">
          This will be accepted and queued, and will wait until a connection is paired.
        </Alert>
      )}

      <Panel title="Send a notification" description="The same endpoint an application would call.">
        <form className="flex flex-col gap-4 px-4 py-4" onSubmit={submit}>
          <Field
            label="Recipient"
            hint="International format, including the country code. A national number cannot be guessed at safely."
          >
            {(fieldProps) => (
              <TextInput
                {...fieldProps}
                value={recipient}
                required
                placeholder="+5511999998888"
                onChange={(event) => {
                  setRecipient(event.target.value);
                }}
              />
            )}
          </Field>

          <Field label="Message">
            {(fieldProps) => (
              <TextArea
                {...fieldProps}
                value={body}
                required
                maxLength={4096}
                onChange={(event) => {
                  setBody(event.target.value);
                }}
              />
            )}
          </Field>

          {send.isError && <Alert title="Not accepted">{send.error.message}</Alert>}

          <div>
            <Button type="submit" variant="primary" isBusy={send.isPending}>
              Send
            </Button>
          </div>
        </form>
      </Panel>

      <Panel
        title="The same thing from your application"
        description="This is exactly the request the form above makes."
      >
        <pre className="overflow-x-auto px-4 py-4 font-mono text-xs text-ink-muted">
          {buildCurlSnippet(
            recipient === '' ? '+5511999998888' : recipient,
            body === '' ? 'Your order has shipped.' : body,
          )}
        </pre>
      </Panel>
    </div>
  );
}
