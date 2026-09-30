import {
  type WaitingNotificationCancellationRequest,
  type WaitingNotificationCancellationResponse,
} from '@platform/contracts';
import { type UseMutationResult } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';

import { Alert, Button, Panel } from './ui';

/**
 * Cancels every notification still waiting to be sent, after one confirmation.
 *
 * Confirmed rather than immediate because it cannot be undone and reaches
 * notifications the person is not looking at. Reported as a number afterwards,
 * because "done" says nothing about how much was.
 */
export function CancelWaitingNotifications({
  description,
  cancellation,
  scope,
}: {
  description: string;
  cancellation: UseMutationResult<
    WaitingNotificationCancellationResponse,
    Error,
    WaitingNotificationCancellationRequest
  >;
  scope: WaitingNotificationCancellationRequest;
}): ReactNode {
  const [isConfirming, setIsConfirming] = useState(false);
  const cancelledCount = cancellation.data?.cancelledCount;

  return (
    <Panel title="Waiting notifications" description={description}>
      <div className="flex flex-col gap-3 px-4 py-4">
        {!isConfirming && (
          <div>
            <Button
              variant="danger"
              onClick={() => {
                cancellation.reset();
                setIsConfirming(true);
              }}
            >
              Cancel everything waiting
            </Button>
          </div>
        )}

        {isConfirming && (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm text-ink">This cannot be undone.</p>
            <Button
              variant="danger"
              isBusy={cancellation.isPending}
              onClick={() => {
                cancellation.mutate(scope, {
                  onSettled: () => {
                    setIsConfirming(false);
                  },
                });
              }}
            >
              Yes, cancel them
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setIsConfirming(false);
              }}
            >
              Keep them
            </Button>
          </div>
        )}

        {cancelledCount !== undefined && (
          <Alert tone={cancelledCount === 0 ? 'neutral' : 'positive'}>
            {cancelledCount === 0
              ? 'Nothing was waiting to be sent.'
              : `Cancelled ${String(cancelledCount)} ${cancelledCount === 1 ? 'notification' : 'notifications'}. None of them will be sent.`}
          </Alert>
        )}

        {cancellation.isError && (
          <Alert title="Could not cancel them">{cancellation.error.message}</Alert>
        )}
      </div>
    </Panel>
  );
}
