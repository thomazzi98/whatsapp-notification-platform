import { type ApplicationConfiguration } from '@platform/configuration';
import {
  type DatabaseConnection,
  WebhookDeliveryRepository,
  WhatsAppSessionRepository,
} from '@platform/database';
import {
  CLOCK_PORT,
  type ClockPort,
  IDENTIFIER_GENERATOR_PORT,
  type IdentifierGeneratorPort,
} from '@platform/domain';
import { logEvents } from '@platform/observability';
import {
  isWebhookSignatureValid,
  isWebhookTimestampAcceptable,
  parseWebhookEnvelope,
} from '@platform/provider-whatsapp';
import { enqueueInTransaction, queueNames } from '@platform/queue';
import { decryptSecret } from '@platform/security';
import { Inject, Injectable } from '@nestjs/common';
import { type PgBoss } from 'pg-boss';

import { APPLICATION_CONFIGURATION, DATABASE_CONNECTION, QUEUE_CLIENT } from '../tokens';

export interface IngestWebhookInput {
  readonly whatsAppSessionId: string;
  readonly rawBody: Buffer;
  readonly signature: string | undefined;
  readonly timestampHeader: string | undefined;
  readonly correlationId: string;
}

export const webhookIngestionOutcomes = ['accepted', 'duplicate', 'rejected', 'malformed'] as const;

export type WebhookIngestionOutcome = (typeof webhookIngestionOutcomes)[number];

export interface IngestWebhookResult {
  readonly outcome: WebhookIngestionOutcome;
  readonly logEvent: string;
  readonly reason?: string;
}

/**
 * Every rejection returns the same result.
 *
 * An unknown session, a missing signature and a wrong signature are
 * indistinguishable to the caller on purpose: a response that told them apart
 * would turn the endpoint into an oracle for which session identifiers exist.
 */
const rejected = (reason: string): IngestWebhookResult => ({
  outcome: 'rejected',
  logEvent: logEvents.webhookRejected,
  reason,
});

@Injectable()
export class IngestWebhookService {
  private readonly connection: DatabaseConnection;
  private readonly deliveries: WebhookDeliveryRepository;
  private readonly whatsAppSessions: WhatsAppSessionRepository;
  private readonly clock: ClockPort;
  private readonly identifiers: IdentifierGeneratorPort;
  private readonly queue: PgBoss;
  private readonly configuration: ApplicationConfiguration;

  public constructor(
    @Inject(DATABASE_CONNECTION) connection: DatabaseConnection,
    @Inject(CLOCK_PORT) clock: ClockPort,
    @Inject(IDENTIFIER_GENERATOR_PORT) identifiers: IdentifierGeneratorPort,
    @Inject(QUEUE_CLIENT) queue: PgBoss,
    @Inject(APPLICATION_CONFIGURATION) configuration: ApplicationConfiguration,
  ) {
    this.connection = connection;
    this.deliveries = new WebhookDeliveryRepository(connection.database);
    this.whatsAppSessions = new WhatsAppSessionRepository(connection.database);
    this.clock = clock;
    this.identifiers = identifiers;
    this.queue = queue;
    this.configuration = configuration;
  }

  private readSigningKey(ciphertext: Buffer): string | undefined {
    try {
      return decryptSecret(ciphertext, this.configuration.security.encryptionKey);
    } catch {
      return undefined;
    }
  }

  /**
   * Authenticates a provider callback and files it, without acting on it.
   *
   * Nothing here interprets the event. The provider retries anything that is
   * not answered quickly, and interpreting a delivery receipt means touching
   * the notification it concerns — which is exactly the work that can be slow
   * or can contend with the dispatcher. Recording and enqueuing in one
   * transaction means an accepted callback is never lost, and never acted on
   * twice.
   */
  public async ingest(input: IngestWebhookInput): Promise<IngestWebhookResult> {
    const session = await this.whatsAppSessions.findByIdWithoutTenantScope(input.whatsAppSessionId);
    if (session === undefined) {
      return rejected('unknown session');
    }
    if (input.signature === undefined || input.signature.length === 0) {
      return rejected('missing signature');
    }

    const signingKey = this.readSigningKey(session.webhookSigningKeyCiphertext);
    if (signingKey === undefined) {
      // A key the platform can no longer read — a rotated encryption key, a
      // damaged row — is an operator problem, but to the caller it has to look
      // exactly like a wrong signature. Anything else would report on the state
      // of a session to someone who has not proved they may know about it.
      return rejected('unreadable signing key');
    }
    if (!isWebhookSignatureValid(input.rawBody, input.signature, signingKey)) {
      return rejected('invalid signature');
    }

    const now = this.clock.now();
    if (
      !isWebhookTimestampAcceptable(
        input.timestampHeader,
        now,
        this.configuration.whatsAppProvider.webhookToleranceSeconds,
      )
    ) {
      // A signature never expires, so without this a captured callback could be
      // replayed at any point in the future.
      return rejected('stale timestamp');
    }

    const envelope = parseWebhookEnvelope(
      // Parsed only after the signature is verified: parsing attacker-supplied
      // JSON before authenticating it is work done on behalf of anyone.
      safeParseJson(input.rawBody),
    );
    if (envelope === undefined) {
      return {
        outcome: 'malformed',
        logEvent: logEvents.webhookRejected,
        reason: 'unparseable body',
      };
    }

    const deliveryId = this.identifiers.generate();
    const recorded = await this.connection.database.transaction(async (transaction) => {
      const delivery = await this.deliveries.record(transaction, {
        id: deliveryId,
        applicationId: session.applicationId,
        whatsAppSessionId: session.id,
        providerEventId: envelope.id,
        eventType: envelope.event,
        providerSessionName: envelope.session,
        payload: envelope.payload,
        receivedAt: now,
      });

      if (delivery === undefined) {
        return;
      }

      await enqueueInTransaction(this.queue, transaction, queueNames.webhookProcess, {
        correlationId: input.correlationId,
        webhookDeliveryId: delivery.id,
      });

      return delivery;
    });

    if (recorded === undefined) {
      return { outcome: 'duplicate', logEvent: logEvents.webhookDuplicate };
    }
    return { outcome: 'accepted', logEvent: logEvents.webhookReceived };
  }
}

function safeParseJson(rawBody: Buffer): unknown {
  try {
    return JSON.parse(rawBody.toString('utf8'));
  } catch {
    return undefined;
  }
}
