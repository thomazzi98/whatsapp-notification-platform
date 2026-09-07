import { type ApplicationConfiguration } from '@platform/configuration';
import { type ApiKeyRecord, ApiKeyRepository, type DatabaseConnection } from '@platform/database';
import {
  type ApiKeyScope,
  CLOCK_PORT,
  type ClockPort,
  DomainError,
  tryParseApiKey,
} from '@platform/domain';
import { isApiKeySecretValid, type GeneratedApiKey, generateApiKey } from '@platform/security';
import { Inject, Injectable } from '@nestjs/common';

import { APPLICATION_CONFIGURATION, DATABASE_CONNECTION } from '../tokens';

export interface CreatedApiKey {
  readonly record: ApiKeyRecord;
  /** Returned once and never stored. */
  readonly plaintextKey: string;
}

export interface ApiKeyPrincipal {
  readonly apiKeyId: string;
  readonly applicationId: string;
  readonly organizationId: string;
  readonly scopes: readonly ApiKeyScope[];
}

@Injectable()
export class ApiKeyService {
  private readonly apiKeys: ApiKeyRepository;
  private readonly configuration: ApplicationConfiguration;
  private readonly clock: ClockPort;

  public constructor(
    @Inject(DATABASE_CONNECTION) connection: DatabaseConnection,
    @Inject(APPLICATION_CONFIGURATION) configuration: ApplicationConfiguration,
    @Inject(CLOCK_PORT) clock: ClockPort,
  ) {
    this.apiKeys = new ApiKeyRepository(connection.database);
    this.configuration = configuration;
    this.clock = clock;
  }

  public async create(input: {
    readonly applicationId: string;
    readonly name: string;
    readonly scopes: readonly ApiKeyScope[];
    readonly createdByUserId: string | null;
    readonly expiresAt: Date | null;
  }): Promise<CreatedApiKey> {
    const environment = this.configuration.nodeEnvironment === 'production' ? 'live' : 'test';
    const generated: GeneratedApiKey = generateApiKey(
      environment,
      this.configuration.security.apiKeyPepper,
    );

    const record = await this.apiKeys.insert({
      applicationId: input.applicationId,
      name: input.name,
      keyIdentifier: generated.identifier,
      keyPrefix: generated.displayPrefix,
      keyHash: generated.keyHash,
      lastFour: generated.lastFour,
      scopes: input.scopes,
      createdByUserId: input.createdByUserId,
      expiresAt: input.expiresAt,
    });

    return { record, plaintextKey: generated.token };
  }

  public async list(applicationId: string): Promise<ApiKeyRecord[]> {
    return this.apiKeys.listForApplication(applicationId);
  }

  public async revoke(applicationId: string, apiKeyId: string): Promise<void> {
    const wasRevoked = await this.apiKeys.revoke(applicationId, apiKeyId, this.clock.now());

    if (!wasRevoked) {
      throw new DomainError('api_key_not_found', 'That API key does not exist.');
    }
  }

  /**
   * Resolves a bearer token to the tenant it belongs to.
   *
   * Returns undefined for every failure mode rather than distinguishing them.
   * A caller holding an invalid token has no legitimate need to know whether it
   * was malformed, unknown, expired or revoked, and saying so would help an
   * attacker narrow down which keys exist.
   */
  public async authenticate(token: string): Promise<ApiKeyPrincipal | undefined> {
    const parsed = tryParseApiKey(token);
    if (parsed === undefined) {
      return undefined;
    }

    const now = this.clock.now();
    const found = await this.apiKeys.findActiveByIdentifier(parsed.identifier, now);
    if (found === undefined) {
      return undefined;
    }
    if (found.applicationStatus !== 'ACTIVE') {
      return undefined;
    }
    if (
      !isApiKeySecretValid(found.keyHash, parsed.secret, this.configuration.security.apiKeyPepper)
    ) {
      return undefined;
    }

    // Recording usage must never delay or fail the request it describes.
    void this.apiKeys.touchLastUsed(found.id, now).catch(() => {
      // Deliberately ignored.
    });

    return {
      apiKeyId: found.id,
      applicationId: found.applicationId,
      organizationId: found.organizationId,
      scopes: found.scopes,
    };
  }
}
