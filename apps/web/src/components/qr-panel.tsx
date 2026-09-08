import { type WhatsAppSessionResponse } from '@platform/contracts';
import { type ReactNode, useEffect, useState } from 'react';

import { useQrCode } from '../api/queries';
import { ConnectionStatusBadge, describeConnectionStatus } from './status';
import { Alert, Button, EmptyState, Loading, Panel } from './ui';

/**
 * The provider issues a limited number of codes before the connection fails
 * outright, so a code fetched by a tab nobody is watching is an attempt spent
 * for nothing. This is the guard that stops a forgotten background tab from
 * burning the budget.
 */
function useIsAttentive(): boolean {
  const [isAttentive, setIsAttentive] = useState(() => document.visibilityState === 'visible');

  useEffect(() => {
    const update = (): void => {
      setIsAttentive(document.visibilityState === 'visible');
    };

    document.addEventListener('visibilitychange', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
    };
  }, []);

  return isAttentive;
}

export function QrPanel({
  applicationId,
  connection,
}: {
  applicationId: string;
  connection: WhatsAppSessionResponse;
}): ReactNode {
  const isAttentive = useIsAttentive();
  const isScannable = connection.status === 'SCAN_QR_CODE';
  const qrCode = useQrCode(applicationId, connection.id, isScannable && isAttentive);

  if (connection.status === 'WORKING') {
    return (
      <Panel title="Connected">
        <div className="px-4 py-6">
          <p className="text-sm text-ink">
            Paired with{' '}
            <span className="font-medium">{connection.phoneNumber ?? 'this account'}</span>
            {connection.pushName === null ? null : ` (${connection.pushName})`}.
          </p>
          <p className="mt-1 text-sm text-ink-muted">
            Notifications for this application will be sent from this WhatsApp account.
          </p>
        </div>
      </Panel>
    );
  }

  if (!isScannable) {
    return (
      <Panel title="Not ready to pair">
        <EmptyState
          title={describeConnectionStatus(connection.status)}
          description={
            connection.status === 'STOPPED'
              ? 'Start the connection to bring it back up. If it was paired before, no new scan is needed.'
              : 'There is no code to scan while the connection is in this state.'
          }
        />
      </Panel>
    );
  }

  return (
    <Panel
      title="Scan to connect"
      description="Open WhatsApp on the phone, go to Linked devices, and scan this code."
      actions={<ConnectionStatusBadge status={connection.status} />}
    >
      <div className="flex flex-col items-center gap-4 px-4 py-6">
        {!isAttentive && (
          <Alert tone="caution" title="Paused">
            Codes expire quickly and the provider only issues a few before the connection fails, so
            this stops requesting them while the tab is in the background. Return to this tab to
            continue.
          </Alert>
        )}

        {qrCode.isPending && isAttentive && <Loading label="Asking WhatsApp for a code…" />}

        {qrCode.isError && (
          <Alert title="No code available">
            {qrCode.error.message} The connection may have moved on; this page will notice within a
            couple of seconds.
          </Alert>
        )}

        {qrCode.data !== undefined && (
          <img
            // A white plate regardless of theme: a QR code on a tinted
            // background is a code some phones will not read.
            className="size-64 rounded-panel border border-border bg-white p-3"
            src={`data:${qrCode.data.mimeType};base64,${qrCode.data.data}`}
            alt="QR code for linking a WhatsApp account to this connection"
          />
        )}

        <p aria-live="polite" className="text-center text-sm text-ink-muted">
          Waiting for the scan. This page updates on its own — there is nothing to press.
        </p>
      </div>
    </Panel>
  );
}

export function ConnectionActions({
  connection,
  onStart,
  onStop,
  onLogout,
  isBusy,
}: {
  connection: WhatsAppSessionResponse;
  onStart: () => void;
  onStop: () => void;
  onLogout: () => void;
  isBusy: boolean;
}): ReactNode {
  const isRunning = connection.status !== 'STOPPED' && connection.status !== 'FAILED';

  return (
    <div className="flex flex-wrap gap-2">
      {/* Never offer an action that cannot succeed: a stopped connection has
          nothing to stop, and a running one is already started. */}
      {isRunning ? (
        <Button onClick={onStop} isBusy={isBusy}>
          Stop
        </Button>
      ) : (
        <Button variant="primary" onClick={onStart} isBusy={isBusy}>
          Start
        </Button>
      )}
      <Button variant="danger" onClick={onLogout} isBusy={isBusy}>
        Unpair
      </Button>
    </div>
  );
}
