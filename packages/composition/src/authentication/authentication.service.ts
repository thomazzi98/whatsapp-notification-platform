import { type ApplicationConfiguration } from '@platform/configuration';
import {
  type DatabaseConnection,
  OrganizationRepository,
  UserRepository,
  UserSessionRepository,
} from '@platform/database';
import { type ClockPort, DomainError } from '@platform/domain';
import { CLOCK_PORT } from '@platform/domain';
import {
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  isPasswordValid,
} from '@platform/security';
import { Inject, Injectable } from '@nestjs/common';

import { APPLICATION_CONFIGURATION, DATABASE_CONNECTION } from '../tokens';

export interface AuthenticatedPrincipal {
  readonly userId: string;
  readonly organizationId: string;
  readonly email: string;
  readonly name: string;
  readonly role: string;
  readonly sessionId: string;
}

export interface EstablishedSession {
  readonly token: string;
  readonly expiresAt: Date;
  readonly principal: Omit<AuthenticatedPrincipal, 'sessionId'> & { readonly sessionId: string };
}

export interface RegisterInput {
  readonly organizationName: string;
  readonly name: string;
  readonly email: string;
  readonly password: string;
}

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

const MAXIMUM_FAILED_LOGINS = 10;
const LOCKOUT_MINUTES = 15;

function toSlug(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 60);
}

@Injectable()
export class AuthenticationService {
  private readonly organizations: OrganizationRepository;
  private readonly users: UserRepository;
  private readonly sessions: UserSessionRepository;
  private readonly configuration: ApplicationConfiguration;
  private readonly clock: ClockPort;

  public constructor(
    @Inject(DATABASE_CONNECTION) connection: DatabaseConnection,
    @Inject(APPLICATION_CONFIGURATION) configuration: ApplicationConfiguration,
    @Inject(CLOCK_PORT) clock: ClockPort,
  ) {
    this.organizations = new OrganizationRepository(connection.database);
    this.users = new UserRepository(connection.database);
    this.sessions = new UserSessionRepository(connection.database);
    this.configuration = configuration;
    this.clock = clock;
  }

  private async establishSession(
    principal: Omit<AuthenticatedPrincipal, 'sessionId'>,
    ipAddress: string | null,
    userAgent: string | null,
  ): Promise<EstablishedSession> {
    const now = this.clock.now();
    const generated = generateSessionToken();
    const absoluteExpiresAt = new Date(
      now.getTime() + this.configuration.security.sessionAbsoluteLifetimeSeconds * 1000,
    );
    const idleExpiresAt = new Date(
      now.getTime() + this.configuration.security.sessionIdleLifetimeSeconds * 1000,
    );

    const sessionId = await this.sessions.insert({
      userId: principal.userId,
      tokenHash: generated.tokenHash,
      absoluteExpiresAt,
      idleExpiresAt: idleExpiresAt > absoluteExpiresAt ? absoluteExpiresAt : idleExpiresAt,
      ipAddress,
      userAgent,
    });

    return {
      token: generated.token,
      expiresAt: absoluteExpiresAt,
      principal: { ...principal, sessionId },
    };
  }

  public async logout(sessionId: string): Promise<void> {
    await this.sessions.revoke(sessionId, this.clock.now());
  }

  public async register(input: RegisterInput): Promise<EstablishedSession> {
    if (!this.configuration.security.registrationEnabled) {
      throw new DomainError('registration_disabled', 'Registration is disabled on this instance.');
    }

    const existing = await this.users.findByEmail(input.email);
    if (existing !== undefined) {
      throw new DomainError('email_already_registered', 'That email address is already in use.');
    }

    const organization = await this.organizations.insert({
      name: input.organizationName,
      slug: `${toSlug(input.organizationName)}-${Date.now().toString(36)}`,
    });

    const user = await this.users.insert({
      organizationId: organization.id,
      email: input.email,
      passwordHash: await hashPassword(input.password),
      name: input.name,
      // The first account in an organization owns it.
      role: 'OWNER',
    });

    return this.establishSession(
      {
        userId: user.id,
        organizationId: user.organizationId,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      null,
      null,
    );
  }

  public async login(input: LoginInput): Promise<EstablishedSession> {
    const user = await this.users.findByEmail(input.email);
    const now = this.clock.now();

    // The same error for an unknown address and a wrong password: telling them
    // apart turns the login form into an account enumeration oracle.
    const invalidCredentials = new DomainError(
      'invalid_credentials',
      'The email address or password is incorrect.',
    );

    if (user === undefined) {
      // Still spend the cost of a hash, so response time does not reveal
      // whether the address exists.
      await hashPassword(input.password);
      throw invalidCredentials;
    }
    if (user.status !== 'ACTIVE') {
      throw new DomainError('account_disabled', 'This account has been disabled.');
    }
    if (user.lockedUntil !== null && user.lockedUntil > now) {
      throw new DomainError('account_locked', 'Too many failed attempts. Try again later.');
    }

    const isPasswordCorrect = await isPasswordValid(user.passwordHash, input.password);
    if (!isPasswordCorrect) {
      const attempts = user.failedLoginCount + 1;
      const lockUntil =
        attempts >= MAXIMUM_FAILED_LOGINS
          ? new Date(now.getTime() + LOCKOUT_MINUTES * 60_000)
          : null;
      await this.users.recordFailedLogin(user.id, lockUntil);
      throw invalidCredentials;
    }

    await this.users.recordSuccessfulLogin(user.id, now);

    return this.establishSession(
      {
        userId: user.id,
        organizationId: user.organizationId,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      input.ipAddress,
      input.userAgent,
    );
  }

  /**
   * Resolves a session cookie to its principal and slides the idle window.
   *
   * The absolute expiry is never extended, so a session that is used constantly
   * still dies at its hard limit.
   */
  public async resolveSession(token: string): Promise<AuthenticatedPrincipal | undefined> {
    const now = this.clock.now();
    const found = await this.sessions.findActiveByTokenHash(hashSessionToken(token), now);

    if (found === undefined) {
      return undefined;
    }
    if (found.status !== 'ACTIVE') {
      return undefined;
    }

    const nextIdleExpiry = new Date(
      now.getTime() + this.configuration.security.sessionIdleLifetimeSeconds * 1000,
    );
    const cappedIdleExpiry =
      nextIdleExpiry > found.absoluteExpiresAt ? found.absoluteExpiresAt : nextIdleExpiry;
    await this.sessions.touch(found.sessionId, cappedIdleExpiry, now);

    return {
      userId: found.userId,
      organizationId: found.organizationId,
      email: found.email,
      name: found.name,
      role: found.role,
      sessionId: found.sessionId,
    };
  }
}
