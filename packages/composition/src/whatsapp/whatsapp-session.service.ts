import { randomBytes } from 'node:crypto';

import { type ApplicationConfiguration } from '@platform/configuration';
import {
  type DatabaseConnection,
  type WhatsAppSessionRecord,
  WhatsAppSessionRepository,
} from '@platform/database';
import {
  CLOCK_PORT,
  type ClockPort,
  DomainError,
  IDENTIFIER_GENERATOR_PORT,
  type IdentifierGeneratorPort,
  type ProviderQrCode,
  WHATSAPP_PROVIDER_PORT,
  type WhatsAppProviderPort,
} from '@platform/domain';
import { encryptSecret } from '@platform/security';
import { Inject, Injectable } from '@nestjs/common';

import { APPLICATION_CONFIGURATION, DATABASE_CONNECTION } from '../tokens';

const SIGNING_KEY_BYTES = 32;

export interface CreateWhatsAppSessionInput {
  readonly applicationId: string;
  readonly displayName: string;
}

@Injectable()
export class WhatsAppSessionService {
  private readonly sessions: WhatsAppSessionRepository;
  private readonly provider: WhatsAppProviderPort;
  private readonly clock: ClockPort;
  private readonly identifiers: IdentifierGeneratorPort;
  private readonly configuration: ApplicationConfiguration;

  public constructor(
    @Inject(DATABASE_CONNECTION) connection: DatabaseConnection,
    @Inject(WHATSAPP_PROVIDER_PORT) provider: WhatsAppProviderPort,
    @Inject(CLOCK_PORT) clock: ClockPort,
    @Inject(IDENTIFIER_GENERATOR_PORT) identifiers: IdentifierGeneratorPort,
    @Inject(APPLICATION_CONFIGURATION) configuration: ApplicationConfiguration,
  ) {
    this.sessions = new WhatsAppSessionRepository(connection.database);
    this.provider = provider;
    this.clock = clock;
    this.identifiers = identifiers;
    this.configuration = configuration;
  }

  /**
   * The provider's session namespace is global and shared by every tenant on
   * the instance, so the name is derived from an identifier that is unique by
   * construction rather than from anything a customer chooses. Two applications
   * asking for "production" must not end up pointing at one WhatsApp account.
   */
  private toProviderSessionName(sessionId: string): string {
    return `wnp-${sessionId}`;
  }

  private toWebhookUrl(sessionId: string): string {
    return `${this.configuration.whatsAppProvider.webhookPublicUrl.replace(/\/+$/, '')}/webhooks/whatsapp/${sessionId}`;
  }

  private async getOrFail(
    applicationId: string,
    sessionId: string,
  ): Promise<WhatsAppSessionRecord> {
    const found = await this.sessions.findById(applicationId, sessionId);

    if (found === undefined) {
      throw new DomainError(
        'whatsapp_session_not_found',
        'That WhatsApp connection does not exist.',
      );
    }
    return found;
  }

  private async recordAndReturn(
    applicationId: string,
    sessionId: string,
    status: WhatsAppSessionRecord['status'],
  ): Promise<WhatsAppSessionRecord> {
    const existing = await this.getOrFail(applicationId, sessionId);

    await this.sessions.recordStatus(sessionId, {
      status,
      phoneNumber: existing.phoneNumber,
      pushName: existing.pushName,
      lastError: null,
      now: this.clock.now(),
    });

    return this.getOrFail(applicationId, sessionId);
  }

  /**
   * Creates the connection here first, then at the provider.
   *
   * The row reserves the provider session name before anything uses it, and the
   * signing key is generated and stored encrypted before it is handed over — so
   * a callback can never arrive for a session whose key the platform does not
   * have. If the provider refuses, the reservation is released rather than left
   * behind to block the next attempt.
   */
  public async create(input: CreateWhatsAppSessionInput): Promise<WhatsAppSessionRecord> {
    const sessionId = this.identifiers.generate();
    const signingKey = randomBytes(SIGNING_KEY_BYTES).toString('hex');

    const record = await this.sessions.insert({
      id: sessionId,
      applicationId: input.applicationId,
      providerSessionName: this.toProviderSessionName(sessionId),
      displayName: input.displayName,
      webhookSigningKeyCiphertext: encryptSecret(
        signingKey,
        this.configuration.security.encryptionKey,
      ),
    });

    const created = await this.provider.createSession({
      sessionName: record.providerSessionName,
      webhookUrl: this.toWebhookUrl(sessionId),
      webhookSigningKey: signingKey,
      start: true,
    });

    if (created.outcome === 'failed') {
      await this.sessions.delete(input.applicationId, sessionId);
      throw new DomainError(
        'whatsapp_provider_unavailable',
        `The WhatsApp provider refused to create the connection: ${created.failure.message}`,
      );
    }

    await this.sessions.recordStatus(sessionId, {
      status: created.value.status,
      phoneNumber: created.value.phoneNumber,
      pushName: created.value.pushName,
      lastError: null,
      now: this.clock.now(),
    });

    return this.getOrFail(input.applicationId, sessionId);
  }

  public async list(applicationId: string): Promise<readonly WhatsAppSessionRecord[]> {
    return this.sessions.listForApplication(applicationId);
  }

  /**
   * Reads the connection, asking the provider for its current state first.
   *
   * Status also arrives by webhook, but a callback can be missed while the API
   * is restarting, and the QR screen is exactly where a stale status is most
   * damaging: it is the one place a person is waiting for the answer.
   */
  public async get(applicationId: string, sessionId: string): Promise<WhatsAppSessionRecord> {
    const record = await this.getOrFail(applicationId, sessionId);
    const live = await this.provider.getSession(record.providerSessionName);

    if (live.outcome === 'failed') {
      return record;
    }

    if (live.value === undefined) {
      // The provider no longer has this connection: its state was wiped, or it
      // was removed behind the platform's back. That is an answer, and it has
      // to be written down, or a record still saying WORKING keeps being
      // chosen for sends that can only fail until somebody reconnects.
      if (record.status !== 'STOPPED') {
        await this.sessions.recordStatus(sessionId, {
          status: 'STOPPED',
          phoneNumber: record.phoneNumber,
          pushName: record.pushName,
          lastError: 'The WhatsApp provider no longer has this connection. Connect it again.',
          now: this.clock.now(),
        });
      }
      return this.getOrFail(applicationId, sessionId);
    }

    await this.sessions.recordStatus(sessionId, {
      status: live.value.status,
      phoneNumber: live.value.phoneNumber,
      pushName: live.value.pushName,
      lastError: null,
      now: this.clock.now(),
    });

    return this.getOrFail(applicationId, sessionId);
  }

  /**
   * Returns the code to scan.
   *
   * Only meaningful while the provider is waiting for one: asking at any other
   * time is an action that cannot succeed, and answering it with a stale image
   * would have someone scanning a code that expired minutes ago.
   */
  public async getQrCode(applicationId: string, sessionId: string): Promise<ProviderQrCode> {
    const record = await this.get(applicationId, sessionId);

    if (record.status !== 'SCAN_QR_CODE') {
      throw new DomainError(
        'whatsapp_session_not_scannable',
        `This connection is ${record.status}, so there is no code to scan.`,
        { currentStatus: record.status },
      );
    }

    const code = await this.provider.getQrCode(record.providerSessionName);
    if (code.outcome === 'failed') {
      throw new DomainError(
        'whatsapp_provider_unavailable',
        `The WhatsApp provider could not produce a code: ${code.failure.message}`,
      );
    }

    return code.value;
  }

  public async start(applicationId: string, sessionId: string): Promise<WhatsAppSessionRecord> {
    const record = await this.getOrFail(applicationId, sessionId);
    const started = await this.provider.startSession(record.providerSessionName);

    if (started.outcome === 'failed') {
      throw new DomainError(
        'whatsapp_provider_unavailable',
        `The WhatsApp provider could not start the connection: ${started.failure.message}`,
      );
    }
    return this.recordAndReturn(applicationId, sessionId, started.value.status);
  }

  /**
   * Stops the connection without unpairing it.
   *
   * The distinction matters to the person doing it: stopping is reversible and
   * logging out is not — restarting resumes, while logging out requires
   * somebody to find the phone and scan a new code.
   */
  public async stop(applicationId: string, sessionId: string): Promise<WhatsAppSessionRecord> {
    const record = await this.getOrFail(applicationId, sessionId);
    const stopped = await this.provider.stopSession(record.providerSessionName);

    if (stopped.outcome === 'failed') {
      throw new DomainError(
        'whatsapp_provider_unavailable',
        `The WhatsApp provider could not stop the connection: ${stopped.failure.message}`,
      );
    }
    return this.recordAndReturn(applicationId, sessionId, stopped.value.status);
  }

  public async logout(applicationId: string, sessionId: string): Promise<WhatsAppSessionRecord> {
    const record = await this.getOrFail(applicationId, sessionId);
    const loggedOut = await this.provider.logoutSession(record.providerSessionName);

    if (loggedOut.outcome === 'failed') {
      throw new DomainError(
        'whatsapp_provider_unavailable',
        `The WhatsApp provider could not log the connection out: ${loggedOut.failure.message}`,
      );
    }
    return this.recordAndReturn(applicationId, sessionId, loggedOut.value.status);
  }

  /**
   * Deletes the connection at the provider first.
   *
   * The other order would leave a paired WhatsApp account running against a
   * session the platform no longer knows about, still receiving messages nobody
   * reads.
   */
  public async delete(applicationId: string, sessionId: string): Promise<void> {
    const record = await this.getOrFail(applicationId, sessionId);
    const deleted = await this.provider.deleteSession(record.providerSessionName);

    if (deleted.outcome === 'failed') {
      throw new DomainError(
        'whatsapp_provider_unavailable',
        `The WhatsApp provider could not delete the connection: ${deleted.failure.message}`,
      );
    }
    await this.sessions.delete(applicationId, sessionId);
  }
}
