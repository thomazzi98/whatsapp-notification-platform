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
  canSessionSend,
  CLOCK_PORT,
  type ClockPort,
  computeNextAttemptAt,
  computeTypingMilliseconds,
  createProviderFailure,
  defaultRetryPolicy,
  IDENTIFIER_GENERATOR_PORT,
  type IdentifierGeneratorPort,
  isRetryable,
  isSendingPaused,
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
import { ConnectionStateService } from '../whatsapp/connection-state.service';

/**
 * Spreads the notifications held by one pause over its first minute, so they
 * do not all wake at the same instant. Pacing would space their sends anyway;
 * this spares it a stampede of claims.
 */
const PAUSE_RESUMPTION_SPREAD_SECONDS = 60;

/**
 * The provider answered as though it had never heard of the session: its
 * state was wiped, or the engine changed underneath it. That is a lost
 * connection, waited for like any other, not a message that can never be sent.
 * A session missing from the platform's own records carries no provider
 * status, and stays the permanent failure it is.
 */
function isSessionLostByProvider(failure: ProviderFailure): boolean {
  return failure.code === 'session_missing' && failure.providerStatusCode !== undefined;
}

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
  | {
      readonly kind: 'not_due';
      readonly dueAt: Date;
      readonly reason: 'not_yet_scheduled' | 'not_yet_due';
    };

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
  private readonly connectionState: ConnectionStateService;

  public constructor(
    @Inject(DATABASE_CONNECTION) connection: DatabaseConnection,
    @Inject(WHATSAPP_PROVIDER_PORT) provider: WhatsAppProviderPort,
    @Inject(CLOCK_PORT) clock: ClockPort,
    @Inject(RANDOM_PORT) random: RandomPort,
    @Inject(IDENTIFIER_GENERATOR_PORT) identifiers: IdentifierGeneratorPort,
    @Inject(QUEUE_CLIENT) queue: PgBoss,
    @Inject(APPLICATION_CONFIGURATION) configuration: ApplicationConfiguration,
    connectionState: ConnectionStateService,
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
    this.connectionState = connectionState;
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
      return { kind: 'not_due', dueAt: existing.scheduledAt, reason: 'not_yet_scheduled' };
    }
    // A second job for a notification that is already waiting: the repair path
    // and a retry can both send one. It must not skip the backoff or the pacing
    // window the waiting one was scheduled to respect.
    if (
      existing?.status === 'RETRYING' &&
      existing.nextAttemptAt !== null &&
      existing.nextAttemptAt.getTime() > now.getTime()
    ) {
      return { kind: 'not_due', dueAt: existing.nextAttemptAt, reason: 'not_yet_due' };
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
    const windowMilliseconds = this.configuration.delivery.maximumLifetimeHours * 3_600_000;

    return this.millisecondsSinceDue(notification) > windowMilliseconds;
  }

  /** How long the notification has been free to go out: since its schedule, or since it was made. */
  private millisecondsSinceDue(notification: NotificationRecord): number {
    const eligibleSince = notification.scheduledAt ?? notification.createdAt;

    return this.clock.now().getTime() - eligibleSince.getTime();
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

    await this.showTyping(notification, session, recipient.chatIdentifier, input);
    if (input.abortSignal?.aborted === true) {
      // The worker began shutting down while "typing…" was up. Nothing has
      // been sent and no attempt spent, so the notification goes back to the
      // queue as it was: sending now would only abort mid-request, and leave
      // an outcome nobody can determine where there was none.
      return this.deferQuietly(notification, this.clock.now(), input, 'worker_stopping');
    }

    const attempt = await this.beginAttempt(notification, claimToken, recipient.chatIdentifier);
    if (attempt === undefined) {
      // The claim was reaped while this worker was still preparing. Another
      // worker owns the notification now, and must not have an attempt consumed
      // on its behalf.
      return { outcome: 'not_claimable' };
    }

    // Enrichment mutates the open scope, so every line for the rest of this
    // dispatch says which attempt it belongs to. Nothing set it before, and
    // without it a retry and a first try read identically in the log.
    enrichCorrelationContext({ attemptNumber: attempt.attemptNumber });

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
      return this.handleSendFailure(
        notification,
        session,
        attempt.attemptNumber,
        result.failure,
        input,
      );
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
    session: WhatsAppSessionRecord,
    attemptNumber: number,
    failure: ProviderFailure,
    input: DispatchInput,
  ): Promise<DispatchResult> {
    if (hasUnknownOutcome(failure)) {
      const policy = await this.readUnknownOutcomePolicy(notification.applicationId);

      return this.resolveUnknownOutcome(notification, attemptNumber, policy, input, failure);
    }

    await this.resolveAttempt(notification, attemptNumber, 'FAILED', { failureCode: failure.code });

    // WhatsApp refused it for the account's reach. Recorded before the
    // notification fails, so the next one already finds the connection paused
    // rather than adding another refusal to the account's record.
    if (failure.code === 'connection_restricted' || failure.code === 'new_chat_quota_exceeded') {
      await this.connectionState.recordRefusal(session, failure.code);
    }
    if (isSessionLostByProvider(failure)) {
      const refreshed = await this.connectionState.refreshStatus(session);

      return this.waitForConnection(notification, refreshed, input);
    }
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
    if (failure.code === 'session_not_ready') {
      // The connection dropped between the last status and this send. Retried
      // on the normal curve, it spent the whole budget in minutes while the
      // record still said WORKING; now the status is read again and the next
      // try waits as long as any other disconnection does.
      await this.connectionState.refreshStatus(session);

      return this.retry(
        notification,
        failure,
        input,
        sessionNotReadyMinimumDelaySeconds,
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
      if (isSessionLostByProvider(resolved.failure)) {
        const refreshed = await this.connectionState.refreshStatus(session);

        return { result: await this.waitForConnection(notification, refreshed, input) };
      }
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
    recipientChatIdentifier: string,
  ): Promise<{ readonly attemptNumber: number } | undefined> {
    const now = this.clock.now();

    return this.connection.database.transaction(async (transaction) => {
      const attemptNumber = await this.notifications.beginAttempt(transaction, {
        applicationId: notification.applicationId,
        notificationId: notification.id,
        claimToken,
        recipientChatIdentifier,
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
   * Returns a notification to the queue without charging it an attempt or
   * writing to its timeline.
   *
   * For decisions the platform makes about WhatsApp rather than things that
   * happened to the message (the pacing window has not opened, the connection
   * is still down), which would otherwise bury the real history under hundreds
   * of "waited" entries.
   */
  private async deferQuietly(
    notification: NotificationRecord,
    until: Date,
    input: DispatchInput,
    detail: string,
  ): Promise<DispatchResult> {
    const now = this.clock.now();

    await this.connection.database.transaction(async (transaction) => {
      await this.notifications.applyTransition(transaction, {
        applicationId: notification.applicationId,
        notificationId: notification.id,
        expectedStatus: 'PROCESSING',
        nextStatus: 'RETRYING',
        changes: { nextAttemptAt: until, claimToken: null, claimedAt: null },
        now,
      });
      await this.enqueueNextAttempt(transaction, notification, until, input);
    });

    return { outcome: 'deferred', detail };
  }

  /**
   * Holds a notification whose connection cannot send, for a limited time.
   *
   * Waiting costs no attempt: nothing was tried, and somebody has to reconnect
   * WhatsApp before anything could be. But the wait ends long before the
   * delivery window does. A number that comes back after an outage would
   * otherwise send the whole backlog in a row (stale messages, to people who
   * stopped expecting them, straight after reconnecting), which is exactly the
   * traffic WhatsApp restricts numbers for.
   *
   * Only the first check is written to the timeline. Every later one repeats
   * the same fact, and a connection that was down for a day once wrote two
   * hundred identical entries into each notification waiting on it.
   */
  private async waitForConnection(
    notification: NotificationRecord,
    session: WhatsAppSessionRecord,
    input: DispatchInput,
  ): Promise<DispatchResult> {
    const waitMinutes = this.configuration.delivery.maximumConnectionWaitMinutes;

    if (this.millisecondsSinceDue(notification) > waitMinutes * 60_000) {
      return this.fail(
        notification,
        createProviderFailure(
          'connection_unavailable',
          `The WhatsApp connection could not send for more than ${String(waitMinutes)} minutes (it is ${session.status}), so the message was not sent late.`,
        ),
        input,
      );
    }

    const failure = createProviderFailure(
      'session_not_ready',
      `The WhatsApp connection is ${session.status} and cannot send.`,
    );

    if (notification.failureCode !== failure.code) {
      return this.retry(notification, failure, input, sessionNotReadyMinimumDelaySeconds);
    }

    const checkAgainAt = new Date(
      this.clock.now().getTime() + sessionNotReadyMinimumDelaySeconds * 1000,
    );
    return this.deferQuietly(notification, checkAgainAt, input, failure.code);
  }

  /**
   * Holds a notification while WhatsApp keeps the connection in a reachout
   * timelock.
   *
   * Nothing is tried in the meantime: every message to a new contact would be
   * refused, and refusals repeated through a timelock are what turn it into a
   * ban. A notification that can wait out the pause within the same limit a
   * disconnection gets waits, costing no attempt; one that cannot is failed
   * now, saying until when, rather than sent hours late.
   */
  private async waitForPause(
    notification: NotificationRecord,
    pausedUntil: Date,
    input: DispatchInput,
  ): Promise<DispatchResult> {
    const waitMinutes = this.configuration.delivery.maximumConnectionWaitMinutes;
    const eligibleSince = (notification.scheduledAt ?? notification.createdAt).getTime();
    const until = pausedUntil.toISOString();

    if (pausedUntil.getTime() > eligibleSince + waitMinutes * 60_000) {
      return this.fail(
        notification,
        createProviderFailure(
          'connection_restricted',
          `WhatsApp is restricting this number from messaging new contacts until ${until}, longer than a notification may wait (${String(waitMinutes)} minutes), so it was not sent.`,
        ),
        input,
      );
    }

    const resumeAt = new Date(
      pausedUntil.getTime() + this.random.integerBetween(0, PAUSE_RESUMPTION_SPREAD_SECONDS) * 1000,
    );
    const failure = createProviderFailure(
      'connection_paused',
      `WhatsApp is restricting this number from messaging new contacts until ${until}. The notification will be sent once it lifts.`,
    );

    // Written to the timeline once, as with a disconnection; every later check
    // repeats the same fact quietly.
    if (notification.failureCode !== failure.code) {
      const secondsUntilResume = Math.ceil(
        (resumeAt.getTime() - this.clock.now().getTime()) / 1000,
      );

      return this.retry(notification, failure, input, Math.max(secondsUntilResume, 0));
    }
    return this.deferQuietly(notification, resumeAt, input, failure.code);
  }

  /**
   * Shows the recipient "typing…" for as long as a person would take to write
   * the message, when that is configured. A courtesy, not a step: whether the
   * indicator appeared says nothing about whether the message can be sent, so
   * its outcome is not looked at.
   */
  private async showTyping(
    notification: NotificationRecord,
    session: WhatsAppSessionRecord,
    chatIdentifier: string,
    input: DispatchInput,
  ): Promise<void> {
    if (!this.configuration.whatsAppProvider.simulateTyping) {
      return;
    }

    await this.provider.showTyping({
      sessionName: session.providerSessionName,
      chatIdentifier,
      durationMilliseconds: computeTypingMilliseconds(
        notification.renderedBody.length,
        this.random,
      ),
      ...(input.abortSignal !== undefined && { abortSignal: input.abortSignal }),
    });
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
      const transitioned = await this.notifications.applyTransition(transaction, {
        applicationId: notification.applicationId,
        notificationId: notification.id,
        expectedStatus: 'PROCESSING',
        nextStatus: step.nextStatus,
        changes: step.changes,
        now: step.now,
      });

      // Zero rows: the claim was reaped while this worker was still deciding,
      // and the notification belongs to someone else now. Nothing happened to
      // it here, so nothing is written about it, and no second job queued.
      if (transitioned === undefined) {
        return;
      }
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
      // A job that arrived early: clock skew, a requeue, a second job for a
      // notification already waiting. Returning without rescheduling could
      // strand the notification with nothing left to dispatch it.
      await this.reschedule(input, claim.dueAt);

      return { outcome: 'deferred', detail: claim.reason };
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

    if (!canSessionSend(session.status)) {
      return this.waitForConnection(claimed, session, input);
    }

    // Before the pacing slot, so a paused connection spends no slot, and
    // nothing at all reaches WhatsApp while it is paused.
    const ready = await this.connectionState.prepareToSend(session);
    if (
      ready.sendingPausedUntil !== null &&
      isSendingPaused(ready.sendingPausedUntil, this.clock.now())
    ) {
      return this.waitForPause(claimed, ready.sendingPausedUntil, input);
    }

    const slot = await this.whatsAppSessions.reserveSendSlot(ready.id, this.clock.now());
    if (!slot.reserved) {
      return this.deferQuietly(claimed, slot.nextSendAllowedAt, input, 'send_pacing');
    }

    return this.deliver(claimed, ready, claimToken, input);
  }
}
