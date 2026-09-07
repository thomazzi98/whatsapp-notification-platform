export const sessionStatuses = [
  'STOPPED',
  'STARTING',
  'SCAN_QR_CODE',
  'WORKING',
  'FAILED',
] as const;

export type SessionStatus = (typeof sessionStatuses)[number];

export interface WebhookConfiguration {
  readonly url: string;
  readonly events: readonly string[];
  readonly hmac?: { readonly key?: string };
}

export interface StubSession {
  name: string;
  status: SessionStatus;
  phoneNumber: string | null;
  pushName: string | null;
  /** How many QR codes have been issued, mirroring the six-code budget. */
  qrAttempt: number;
  qrExpiresAt: number | null;
  webhooks: WebhookConfiguration[];
  failureReason: string | null;
}

export const MAXIMUM_QR_ATTEMPTS = 6;
export const FIRST_QR_LIFETIME_MILLISECONDS = 60_000;
export const SUBSEQUENT_QR_LIFETIME_MILLISECONDS = 20_000;

export class SessionStore {
  private readonly sessions = new Map<string, StubSession>();

  public reset(): void {
    this.sessions.clear();
  }

  public list(): StubSession[] {
    return [...this.sessions.values()];
  }

  public find(name: string): StubSession | undefined {
    return this.sessions.get(name);
  }

  public create(name: string, webhooks: WebhookConfiguration[]): StubSession {
    const session: StubSession = {
      name,
      status: 'STOPPED',
      phoneNumber: null,
      pushName: null,
      qrAttempt: 0,
      qrExpiresAt: null,
      webhooks,
      failureReason: null,
    };
    this.sessions.set(name, session);

    return session;
  }

  public remove(name: string): boolean {
    return this.sessions.delete(name);
  }

  /**
   * Mirrors the real engine: starting moves through STARTING to SCAN_QR_CODE
   * unless credentials already exist, in which case it goes straight to
   * WORKING. The stub keeps that distinction so reconnect behaviour can be
   * tested without a phone.
   */
  public start(session: StubSession, now: number): void {
    if (session.phoneNumber !== null) {
      session.status = 'WORKING';
      return;
    }
    session.status = 'SCAN_QR_CODE';
    session.qrAttempt = 1;
    session.qrExpiresAt = now + FIRST_QR_LIFETIME_MILLISECONDS;
  }

  public issueNextQrCode(session: StubSession, now: number): void {
    if (session.qrAttempt >= MAXIMUM_QR_ATTEMPTS) {
      session.status = 'FAILED';
      session.failureReason = 'QR_ATTEMPTS_EXHAUSTED';
      session.qrExpiresAt = null;
      return;
    }
    session.qrAttempt += 1;
    session.qrExpiresAt = now + SUBSEQUENT_QR_LIFETIME_MILLISECONDS;
  }

  /** Stands in for a human scanning the code. */
  public completeScan(session: StubSession, phoneNumber: string, pushName: string): void {
    session.status = 'WORKING';
    session.phoneNumber = phoneNumber;
    session.pushName = pushName;
    session.qrExpiresAt = null;
    session.failureReason = null;
  }

  public logout(session: StubSession): void {
    session.status = 'STOPPED';
    session.phoneNumber = null;
    session.pushName = null;
    session.qrAttempt = 0;
    session.qrExpiresAt = null;
  }
}
