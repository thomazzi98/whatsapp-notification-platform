import { type ProviderFailure } from '../notification/provider-failure';

/**
 * Session states the platform understands.
 *
 * `UNKNOWN` exists because the provider is free to add states in a newer
 * release. Parsing permissively into it means an upgrade degrades the dashboard
 * to "we do not recognise this" rather than crashing the poller.
 */
export const providerSessionStatuses = [
  'STOPPED',
  'STARTING',
  'SCAN_QR_CODE',
  'WORKING',
  'FAILED',
  'UNKNOWN',
] as const;

export type ProviderSessionStatus = (typeof providerSessionStatuses)[number];

export function isProviderSessionStatus(candidate: string): candidate is ProviderSessionStatus {
  return (providerSessionStatuses as readonly string[]).includes(candidate);
}

export function toProviderSessionStatus(candidate: string): ProviderSessionStatus {
  return isProviderSessionStatus(candidate) ? candidate : 'UNKNOWN';
}

export function canSessionSend(status: ProviderSessionStatus): boolean {
  return status === 'WORKING';
}

export interface ProviderSession {
  readonly name: string;
  readonly status: ProviderSessionStatus;
  readonly phoneNumber: string | null;
  readonly pushName: string | null;
}

export interface ProviderQrCode {
  readonly mimeType: string;
  /** Base64 encoded image bytes. */
  readonly data: string;
}

export interface ResolvedRecipient {
  readonly isRegistered: boolean;
  /**
   * The provider's own chat identifier. Always preferred over one built
   * locally, because national numbering rules — the Brazilian ninth digit in
   * particular — make a constructed identifier unreliable.
   */
  readonly chatIdentifier: string | null;
}

export interface SentMessage {
  /** Opaque to the platform, and flat: the provider returns a string, not an object. */
  readonly providerMessageId: string;
}

export interface SendTextMessageInput {
  readonly sessionName: string;
  readonly chatIdentifier: string;
  readonly text: string;
  /** Aborts the request when the worker is shutting down. */
  readonly abortSignal?: AbortSignal;
}

export interface CreateSessionInput {
  readonly sessionName: string;
  readonly webhookUrl: string;
  readonly webhookSigningKey: string;
  readonly start: boolean;
}

/**
 * Every operation reports failure as a value rather than throwing.
 *
 * A provider being unreachable, rate limiting, or rejecting a recipient are
 * expected conditions in this system, not exceptional ones. Making them part of
 * the return type forces each caller to decide what the failure means, which is
 * exactly the decision that determines whether a notification is retried.
 */
export type ProviderResult<Value> =
  | { readonly outcome: 'succeeded'; readonly value: Value }
  | { readonly outcome: 'failed'; readonly failure: ProviderFailure };

export function succeeded<Value>(value: Value): ProviderResult<Value> {
  return { outcome: 'succeeded', value };
}

export function failed<Value>(failure: ProviderFailure): ProviderResult<Value> {
  return { outcome: 'failed', failure };
}

export interface WhatsAppProviderPort {
  createSession: (input: CreateSessionInput) => Promise<ProviderResult<ProviderSession>>;
  getSession: (sessionName: string) => Promise<ProviderResult<ProviderSession | undefined>>;
  startSession: (sessionName: string) => Promise<ProviderResult<ProviderSession>>;
  stopSession: (sessionName: string) => Promise<ProviderResult<ProviderSession>>;
  logoutSession: (sessionName: string) => Promise<ProviderResult<ProviderSession>>;
  deleteSession: (sessionName: string) => Promise<ProviderResult<void>>;
  getQrCode: (sessionName: string) => Promise<ProviderResult<ProviderQrCode>>;
  resolveRecipient: (
    sessionName: string,
    phoneNumber: string,
  ) => Promise<ProviderResult<ResolvedRecipient>>;
  sendTextMessage: (input: SendTextMessageInput) => Promise<ProviderResult<SentMessage>>;
}

export const WHATSAPP_PROVIDER_PORT = Symbol('WhatsAppProviderPort');
