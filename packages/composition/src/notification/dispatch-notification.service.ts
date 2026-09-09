import { randomUUID } from 'node:crypto';

import { type ApplicationConfiguration } from '@platform/configuration';
import {
  ApplicationRepository,
  type DatabaseConnection,
  type NotificationRecord,
  NotificationRepository,
  NotificationSendAttemptRepository,
  type DatabaseTransaction,
  type NotificationTransitionChanges,
  type SendAttemptOutcome,
  type WhatsAppSessionRecord,
  WhatsAppSessionRepository,
} from '@platform/database';
import {
  CLOCK_PORT,
  type ClockPort,
  computeNextAttemptAt,
  createProviderFailure,
  defaultRetryPolicy,
  IDENTIFIER_GENERATOR_PORT,
  type IdentifierGeneratorPort,
  isRetryable,
  hasUnknownOutcome,
  maskPhoneNumberForLog,
  type NotificationStatus,
  type ProviderFailure,
  RANDOM_PORT,
  type RandomPort,
  sessionNotReadyMinimumDelaySeconds,
  WHATSAPP_PROVIDER_PORT,
  type WhatsAppProviderPort,
} from '@platform/domain';
import { enrichCorrelationContext, hashRecipient } from '@platform/observability';
import { enqueueInTransaction, queueNames } from '@platform/queue';
import { Inject, Injectable } from '@nestjs/common';
import { type PgBoss } from 'pg-boss';

import { APPLICATION_CONFIGURATION, DATABASE_CONNECTION, QUEUE_CLIENT } from '../tokens';

export interface DispatchInput {
  readonly applicationId: string;
  readonly notificationId: string;
  readonly correlationId: string;
  /** Aborted when the worker is shutting down, so an in-flight send stops promptly. */
  readonly abortSignal?: AbortSignal;
}

export const dispatchOutcomes = [
  'sent',
  'retry_scheduled',
  'failed',
  'deferred',
  'not_claimable',
] as const;

export type DispatchOutcome = (typeof dispatchOutcomes)[number];

export interface DispatchResult {
  readonly outcome: DispatchOutcome;
  readonly detail?: string;
}

/** What the platform does when a send's outcome cannot be determined. */
type UnknownOutcomePolicy = 'RETRY' | 'FAIL_CLOSED';

type ClaimResult =
  | { readonly kind: 'claimed'; readonly notification: NotificationRecord }
  | { readonly kind: 'not_claimable' }
  | { readonly kind: 'not_due'; readonly dueAt: Date };

interface TransitionStep {
  readonly nextStatus: NotificationStatus;
  readonly eventType: string;
  readonly attemptNumber: number | null;
  readonly failure: ProviderFailure;
  readonly changes: NotificationTransitionChanges;
  readonly payload: Record<string, unknown>;
  readonly enqueueAt?: Date;
  readonly input: DispatchInput;
  readonly now: Date;
}

@Injectable()
export class DispatchNotificationService {
  private readonly connection: DatabaseConnection;
  private readonly notifications: NotificationRepository;
  private readonly sendAttempts: NotificationSendAttemptRepository;
  private readonly whatsAppSessions: WhatsAppSessionRepository;
  private readonly applications: ApplicationRepository;
  private readonly provider: WhatsAppProviderPort;
  private readonly clock: ClockPort;
  private readonly random: RandomPort;
  private readonly identifiers: IdentifierGeneratorPort;
  private readonly queue: PgBoss;
  private readonly configuration: ApplicationConfiguration;

  public constructor(
    @Inject(DATABASE_CONNECTION) connection: DatabaseConnection,
    @Inject(WHATSAPP_PROVIDER_PORT) provider: WhatsAppProviderPort,
    @Inject(CLOCK_PORT) clock: ClockPort,
    @Inject(RANDOM_PORT) random: RandomPort,
    @Inject(IDENTIFIER_GENERATOR_PORT) identifiers: IdentifierGeneratorPort,
    @Inject(QUEUE_CLIENT) queue: PgBoss,
    @Inject(APPLICATION_CONFIGURATION) configuration: ApplicationConfiguration,
  ) {
    this.connection = connection;
    this.notifications = new NotificationRepository(connection.database);
    this.sendAttempts = new NotificationSendAttemptRepository(connection.database);
    this.whatsAppSessions = new WhatsAppSessionRepository(connection.database);
    this.applications = new ApplicationRepository(connection.database);
    this.provider = provider;
    this.clock = clock;
    this.random = random;
    this.identifiers = identifiers;
    this.queue = queue;
    this.configuration = configuration;
  }

  /**
   * Takes ownership of the notification, promoting a scheduled one first.
   *
   * SCHEDULED is deliberately not a state a worker may dispatch from, so a job
   * arriving at its scheduled time moves the row into the queue before claiming
   * it. Both steps are conditional updates, so a job that arrives early or
   * twice changes nothing.
   */
  private async claim(input: DispatchInput, claimToken: string): Promise<ClaimResult> {
    const now = this.clock.now();
    const promoted = await this.notifications.promoteScheduled(
      input.applicationId,
      input.notificationId,
      now,
    );

    if (promoted !== undefined) {
      await this.notifications.appendEvent(this.connection.database, {
        id: this.identifiers.generate(),
        applicationId: input.applicationId,
        notificationId: input.notificationId,
        eventType: 'notification.queued',
        fromStatus: 'SCHEDULED',
        toStatus: 'QUEUED',
        attemptNumber: null,
        payload: {},
        correlationId: input.correlationId,
      });
    }

    const claimed = await this.notifications.claimForDispatch(
      input.applicationId,
      input.notificationId,
      claimToken,
      now,
    );

    if (claimed !== undefined) {
      return { kind: 'claimed', notification: claimed };
    }

    return this.explainFailedClaim(input, now);
  }

  private async explainFailedClaim(input: DispatchInput, now: Date): Promise<ClaimResult> {
    const existing = await this.notifications.findById(input.applicationId, input.notificationId);

    if (
      existing?.status === 'SCHEDULED' &&
      existing.scheduledAt !== null &&
      existing.scheduledAt.getTime() > now.getTime()
    ) {
      return { kind: 'not_due', dueAt: existing.scheduledAt };
    }
    return { kind: 'not_claimable' };
  }

  private async reschedule(input: DispatchInput, dueAt: Date): Promise<void> {
    await this.connection.database.transaction(async (transaction) => {
      await enqueueInTransaction(
        this.queue,
        transaction,
        queueNames.notificationDispatch,
        {
          correlationId: input.correlationId,
          notificationId: input.notificationId,
          applicationId: input.applicationId,
        },
        { singletonKey: input.notificationId, startAfter: dueAt },
      );
    });
  }

  /**
   * A message that has been waiting for a day is no longer the message the
   * caller meant to send — an expired code, a stale order update. Failing it is
   * more honest than delivering it late, and it is also what stops a
   * permanently disconnected WhatsApp connection from accumulating an unbounded
   * backlog of retries.
   */
  private hasOutlivedDeliveryWindow(notification: NotificationRecord): boolean {
    const eligibleSince = notification.scheduledAt ?? notification.createdAt;
    const windowMilliseconds = this.configuration.delivery.maximumLifetimeHours * 3_600_000;

    return this.clock.now().getTime() - eligibleSince.getTime() > windowMilliseconds;
  }

  private async readUnknownOutcomePolicy(applicationId: string): Promise<UnknownOutcomePolicy> {
    const settings = await this.applications.findDeliverySettings(applicationId);

    // An archived application has no settings row; its notifications retry on
    // the default policy until the delivery window closes them.
    return settings?.unknownOutcomePolicy ?? 'RETRY';
  }

  /**
   * Sends the message.
   *
   * The attempt is consumed and committed before the provider is contacted, so
   * the ledger always records at least as many attempts as WhatsApp saw. The
   * reverse ordering would let a crash hide a delivered message.
   */
  private async deliver(
    notification: NotificationRecord,
    session: WhatsAppSessionRecord,
    claimToken: string,
    input: DispatchInput,
  ): Promise<DispatchResult> {
    const recipient = await this.resolveRecipient(notification, session, input);
    if ('result' in recipient) {
      return recipient.result;
    }

    const attempt = await this.beginAttempt(notification, claimToken);
    if (attempt === undefined) {
      // The claim was reaped while this worker was still preparing. Another
      // worker owns the notification now, and must not have an attempt consumed
      // on its behalf.
      return { outcome: 'not_claimable' };
    }

    if (attempt.attemptNumber > notification.maximumAttempts) {
      return this.fail(
        notification,
        createProviderFailure(
          'maximum_attempts_exhausted',
          `Delivery was attempted ${String(notification.maximumAttempts)} times without success.`,
        ),
        input,
        attempt.attemptNumber,
      );
    }

    const result = await this.provider.sendTextMessage({
      sessionName: session.providerSessionName,
      chatIdentifier: recipient.chatIdentifier,
      text: notification.renderedBody,
      ...(input.abortSignal !== undefined && { abortSignal: input.abortSignal }),
    });

    if (result.outcome === 'failed') {
      return this.handleSendFailure(notification, attempt.attemptNumber, result.failure, input);
    }

    const now = this.clock.now();

    // The attempt ledger and the SENT row commit together. Resolved separately,
    // a crash in the window between them left an attempt marked SUCCEEDED on a
    // notification still PROCESSING: the reaper returned it to the queue and
    // WhatsApp received the message twice, and because the attempt had a
    // resolved outcome it was never treated as unknown, so FAIL_CLOSED did not
    // protect the tenants who chose it.
    const wasRecorded = await this.connection.database.transaction(async (transaction) => {
      const transitioned = await this.notifications.applyTransition(transaction, {
        applicationId: notification.applicationId,
        notificationId: notification.id,
        expectedStatus: 'PROCESSING',
        nextStatus: 'SENT',
        changes: {
          providerMessageId: result.value.providerMessageId,
          recipientChatIdentifier: recipient.chatIdentifier,
          sentAt: now,
          claimToken: null,
          claimedAt: null,
          nextAttemptAt: null,
        },
        now,
      });

      // Zero rows means the notification is no longer this worker's to move.
      // notification_events is append-only by grant, so an event written for a
      // transition that did not happen is a permanently uncorrectable entry in
      // the timeline the public API serves.
      if (transitioned === undefined) {
        return false;
      }

      await this.resolveAttempt(
        notification,
        attempt.attemptNumber,
        'SUCCEEDED',
        { providerMessageId: result.value.providerMessageId },
        transaction,
      );
      await this.notifications.appendEvent(transaction, {
        id: this.identifiers.generate(),
        applicationId: notification.applicationId,
        notificationId: notification.id,
        eventType: 'notification.sent',
        fromStatus: 'PROCESSING',
        toStatus: 'SENT',
        attemptNumber: attempt.attemptNumber,
        // SENT means WhatsApp accepted the message, not that anyone received
        // it. DELIVERED arrives later, as an acknowledgement webhook.
        payload: { providerMessageId: result.value.providerMessageId },
        correlationId: input.correlationId,
      });

      return true;
    });

    if (!wasRecorded) {
      // The message did reach WhatsApp. Reporting it as sent would be a lie
      // about who owns the row; reporting a failure would be a lie about the
      // message. The claim is what was lost, so that is what is reported.
      return { outcome: 'not_claimable' };
    }

    return { outcome: 'sent' };
  }

  private async handleSendFailure(
    notification: NotificationRecord,
    attemptNumber: number,
    failure: ProviderFailure,
    input: DispatchInput,
  ): Promise<DispatchResult> {
    if (hasUnknownOutcome(failure)) {
      const policy = await this.readUnknownOutcomePolicy(notification.applicationId);

      return this.resolveUnknownOutcome(notification, attemptNumber, policy, input, failure);
    }

    await this.resolveAttempt(notification, attemptNumber, 'FAILED', { failureCode: failure.code });

    if (!isRetryable(failure)) {
      return this.fail(notification, failure, input, attemptNumber);
    }
    if (attemptNumber >= notification.maximumAttempts) {
      return this.fail(
        notification,
        createProviderFailure(
          'maximum_attempts_exhausted',
          `Delivery was attempted ${String(attemptNumber)} times without success. The last error was: ${failure.message}`,
        ),
        input,
        attemptNumber,
      );
    }
    return this.retry(notification, failure, input, 0, attemptNumber);
  }

  /**
   * Decides what to do about a send whose outcome cannot be determined.
   *
   * The provider accepts no idempotency key, so there is no answer that is safe
   * in both directions: resending risks delivering the message twice, and
   * failing risks discarding one that arrived. The tenant chooses which risk it
   * prefers, and the choice is written to the timeline either way, so nobody
   * has to guess afterwards what the platform did.
   */
  private async resolveUnknownOutcome(
    notification: NotificationRecord,
    attemptNumber: number,
    policy: UnknownOutcomePolicy,
    input: DispatchInput,
    failure?: ProviderFailure,
  ): Promise<DispatchResult> {
    const cause =
      failure ??
      createProviderFailure(
        'provider_outcome_unknown',
        'A previous attempt was interrupted before WhatsApp answered.',
      );

    await this.resolveAttempt(notification, attemptNumber, 'UNKNOWN', { failureCode: cause.code });

    if (policy === 'FAIL_CLOSED') {
      return this.fail(
        notification,
        createProviderFailure(
          'unknown_outcome_fail_closed',
          `The outcome of attempt ${String(attemptNumber)} is unknown, and this application is configured to stop rather than risk sending the same message twice. Cause: ${cause.message}`,
        ),
        input,
        attemptNumber,
      );
    }

    if (attemptNumber >= notification.maximumAttempts) {
      return this.fail(
        notification,
        createProviderFailure(
          'maximum_attempts_exhausted',
          `Delivery was attempted ${String(attemptNumber)} times and the last outcome could not be determined.`,
        ),
        input,
        attemptNumber,
      );
    }

    return this.retry(
      notification,
      createProviderFailure('provider_outcome_unknown', cause.message),
      input,
      0,
      attemptNumber,
    );
  }

  /**
   * Finds the identifier to send to.
   *
   * Resolved once and then cached on the notification: the lookup costs a
   * provider round trip, and repeating it on every retry would spend the
   * session's budget re-answering a question already answered.
   */
  private async resolveRecipient(
    notification: NotificationRecord,
    session: WhatsAppSessionRecord,
    input: DispatchInput,
  ): Promise<{ readonly chatIdentifier: string } | { readonly result: DispatchResult }> {
    if (notification.recipientChatIdentifier !== null) {
      return { chatIdentifier: notification.recipientChatIdentifier };
    }

    const resolved = await this.provider.resolveRecipient(
      session.providerSessionName,
      notification.recipientPhoneNumber,
    );

    if (resolved.outcome === 'failed') {
      if (!isRetryable(resolved.failure)) {
        return { result: await this.fail(notification, resolved.failure, input) };
      }
      // The same floor as a disconnected session, and for the same reason: the
      // provider cannot answer a question right now, which is not something the
      // message did wrong and not worth asking again in thirty seconds.
      return {
        result: await this.retry(
          notification,
          resolved.failure,
          input,
          sessionNotReadyMinimumDelaySeconds,
        ),
      };
    }
    if (!resolved.value.isRegistered || resolved.value.chatIdentifier === null) {
      return {
        result: await this.fail(
          notification,
          createProviderFailure(
            'recipient_not_on_whatsapp',
            'That number is not registered on WhatsApp.',
          ),
          input,
        ),
      };
    }

    // Always the identifier the provider returned, never one built locally:
    // national numbering rules make a constructed identifier unreliable.
    return { chatIdentifier: resolved.value.chatIdentifier };
  }

  private async beginAttempt(
    notification: NotificationRecord,
    claimToken: string,
  ): Promise<{ readonly attemptNumber: number } | undefined> {
    const now = this.clock.now();

    return this.connection.database.transaction(async (transaction) => {
      const attemptNumber = await this.notifications.beginAttempt(transaction, {
        applicationId: notification.applicationId,
        notificationId: notification.id,
        claimToken,
        now,
      });

      if (attemptNumber === undefined) {
        return;
      }

      await this.sendAttempts.begin(transaction, {
        id: this.identifiers.generate(),
        applicationId: notification.applicationId,
        notificationId: notification.id,
        attemptNumber,
        requestStartedAt: now,
      });

      return { attemptNumber };
    });
  }

  private async resolveAttempt(
    notification: NotificationRecord,
    attemptNumber: number,
    outcome: SendAttemptOutcome,
    details: { readonly providerMessageId?: string; readonly failureCode?: string },
    executor?: DatabaseTransaction,
  ): Promise<void> {
    await this.sendAttempts.resolve(
      {
        applicationId: notification.applicationId,
        notificationId: notification.id,
        attemptNumber,
        outcome,
        ...details,
        now: this.clock.now(),
      },
      executor,
    );
  }

  /**
   * Returns a paced notification to the queue without charging it an attempt.
   *
   * Pacing is a decision the platform makes about WhatsApp rather than
   * something that happened to the message, so it writes no timeline event: a
   * busy session would otherwise bury the real history under hundreds of
   * "waited" entries.
   */
  private async deferForPacing(
    notification: NotificationRecord,
    nextSendAllowedAt: Date,
    input: DispatchInput,
  ): Promise<DispatchResult> {
    const now = this.clock.now();

    await this.connection.database.transaction(async (transaction) => {
      await this.notifications.applyTransition(transaction, {
        applicationId: notification.applicationId,
        notificationId: notification.id,
        expectedStatus: 'PROCESSING',
        nextStatus: 'RETRYING',
        changes: { nextAttemptAt: nextSendAllowedAt, claimToken: null, claimedAt: null },
        now,
      });
      await this.enqueueNextAttempt(transaction, notification, nextSendAllowedAt, input);
    });

    return { outcome: 'deferred', detail: 'send_pacing' };
  }

  private async retry(
    notification: NotificationRecord,
    failure: ProviderFailure,
    input: DispatchInput,
    minimumDelaySeconds = 0,
    attemptNumber: number | null = null,
  ): Promise<DispatchResult> {
    const now = this.clock.now();
    // A provider that asked to be left alone for a while outranks the curve.
    const floor = Math.max(minimumDelaySeconds, failure.retryAfterSeconds ?? 0);
    const nextAttemptAt = computeNextAttemptAt(
      defaultRetryPolicy,
      Math.max(attemptNumber ?? notification.attemptCount, 1),
      this.random,
      now,
      floor,
    );

    await this.transitionAndRecord(notification, {
      nextStatus: 'RETRYING',
      eventType: 'notification.retry_scheduled',
      attemptNumber,
      failure,
      changes: {
        nextAttemptAt,
        failureCode: failure.code,
        failureReason: failure.message,
        failureClassification: failure.classification,
        claimToken: null,
        claimedAt: null,
      },
      payload: { nextAttemptAt: nextAttemptAt.toISOString() },
      enqueueAt: nextAttemptAt,
      input,
      now,
    });

    return { outcome: 'retry_scheduled', detail: failure.code };
  }

  private async fail(
    notification: NotificationRecord,
    failure: ProviderFailure,
    input: DispatchInput,
    attemptNumber: number | null = null,
  ): Promise<DispatchResult> {
    const now = this.clock.now();

    await this.transitionAndRecord(notification, {
      nextStatus: 'FAILED',
      eventType: 'notification.failed',
      attemptNumber,
      failure,
      changes: {
        failedAt: now,
        failureCode: failure.code,
        failureReason: failure.message,
        failureClassification: failure.classification,
        claimToken: null,
        claimedAt: null,
        nextAttemptAt: null,
      },
      payload: { recipient: maskPhoneNumberForLog(notification.recipientPhoneNumber) },
      input,
      now,
    });

    return { outcome: 'failed', detail: failure.code };
  }

  private async transitionAndRecord(
    notification: NotificationRecord,
    step: TransitionStep,
  ): Promise<void> {
    await this.connection.database.transaction(async (transaction) => {
      await this.notifications.applyTransition(transaction, {
        applicationId: notification.applicationId,
        notificationId: notification.id,
        expectedStatus: 'PROCESSING',
        nextStatus: step.nextStatus,
        changes: step.changes,
        now: step.now,
      });
      await this.notifications.appendEvent(transaction, {
        id: this.identifiers.generate(),
        applicationId: notification.applicationId,
        notificationId: notification.id,
        eventType: step.eventType,
        fromStatus: 'PROCESSING',
        toStatus: step.nextStatus,
        attemptNumber: step.attemptNumber,
        payload: {
          ...step.payload,
          failureCode: step.failure.code,
          failureClassification: step.failure.classification,
          ...(step.failure.providerStatusCode !== undefined && {
            providerStatusCode: step.failure.providerStatusCode,
          }),
        },
        correlationId: step.input.correlationId,
      });

      if (step.enqueueAt !== undefined) {
        await this.enqueueNextAttempt(transaction, notification, step.enqueueAt, step.input);
      }
    });
  }

  /**
   * Enqueues the next dispatch in the same transaction that recorded the
   * decision, so a notification can never be left in RETRYING with nothing
   * scheduled to pick it up.
   */
  private async enqueueNextAttempt(
    transaction: DatabaseTransaction,
    notification: NotificationRecord,
    startAfter: Date,
    input: DispatchInput,
  ): Promise<void> {
    await enqueueInTransaction(
      this.queue,
      transaction,
      queueNames.notificationDispatch,
      {
        correlationId: input.correlationId,
        notificationId: notification.id,
        applicationId: notification.applicationId,
      },
      { singletonKey: notification.id, startAfter },
    );
  }

  /**
   * Delivers one notification.
   *
   * The order of the steps is the design, and each one closes a specific hole.
   * Claiming first, with a compare-and-swap, is what makes concurrent double
   * dispatch impossible. Resolving an earlier unfinished attempt before
   * starting a new one is what stops a crash from silently sending the same
   * message twice. Consuming an attempt in a transaction that commits before
   * the network call is what bounds how many times a message can reach WhatsApp
   * at all.
   */
  public async dispatch(input: DispatchInput): Promise<DispatchResult> {
    const claimToken = randomUUID();
    const claim = await this.claim(input, claimToken);

    if (claim.kind === 'not_claimable') {
      // Another worker owns it, it is already terminal, or it was cancelled.
      // The job completes successfully: throwing would earn a redelivery that
      // would reach exactly the same conclusion.
      return { outcome: 'not_claimable' };
    }
    if (claim.kind === 'not_due') {
      // A job that arrived before its scheduled time — clock skew, or a
      // requeue. Returning without rescheduling would strand the notification
      // in SCHEDULED with nothing left to dispatch it.
      await this.reschedule(input, claim.dueAt);

      return { outcome: 'deferred', detail: 'not_yet_scheduled' };
    }

    const claimed = claim.notification;

    // Every log line from here on can be joined on the recipient without the
    // number itself ever being written to a log.
    enrichCorrelationContext({
      recipientHash: hashRecipient(
        claimed.recipientPhoneNumber,
        this.configuration.observability.recipientSalt,
      ),
    });

    if (this.hasOutlivedDeliveryWindow(claimed)) {
      return this.fail(
        claimed,
        createProviderFailure(
          'delivery_window_expired',
          `The notification waited longer than the ${String(this.configuration.delivery.maximumLifetimeHours)} hour delivery window without being sent.`,
        ),
        input,
      );
    }

    const unresolved = await this.sendAttempts.findUnresolved(claimed.applicationId, claimed.id);
    if (unresolved !== undefined) {
      const policy = await this.readUnknownOutcomePolicy(claimed.applicationId);

      return this.resolveUnknownOutcome(claimed, unresolved.attemptNumber, policy, input);
    }

    const session = await this.whatsAppSessions.findById(
      claimed.applicationId,
      claimed.whatsAppSessionId,
    );

    if (session === undefined) {
      return this.fail(
        claimed,
        createProviderFailure(
          'session_missing',
          'The WhatsApp connection this notification was queued against no longer exists.',
        ),
        input,
      );
    }

    if (session.status !== 'WORKING') {
      // Not a delivery failure: a human has to reconnect WhatsApp. It costs no
      // attempt, so a disconnection of any length is survivable and the backlog
      // flows again the moment the connection returns.
      return this.retry(
        claimed,
        createProviderFailure(
          'session_not_ready',
          `The WhatsApp connection is ${session.status} and cannot send.`,
        ),
        input,
        sessionNotReadyMinimumDelaySeconds,
      );
    }

    const slot = await this.whatsAppSessions.reserveSendSlot(session.id, this.clock.now());
    if (!slot.reserved) {
      return this.deferForPacing(claimed, slot.nextSendAllowedAt, input);
    }

    return this.deliver(claimed, session, claimToken, input);
  }
}
