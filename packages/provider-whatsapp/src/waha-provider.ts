import {
  createProviderFailure,
  type CreateSessionInput,
  failed,
  type ProviderQrCode,
  type ProviderResult,
  type ProviderSession,
  normalizeProviderMessageId,
  type ResolvedRecipient,
  type SendTextMessageInput,
  type SentMessage,
  succeeded,
  toProviderSessionStatus,
  type WhatsAppProviderPort,
} from '@platform/domain';
import { z } from 'zod';

import { classifyHttpStatus, classifyTransportError } from './classify-failure';

export interface WahaProviderOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly requestTimeoutMilliseconds: number;
  /** Events the platform subscribes to when it creates a session. */
  readonly webhookEvents?: readonly string[];
}

const DEFAULT_WEBHOOK_EVENTS = ['session.status', 'message.ack', 'state.change'] as const;

const sessionResponseSchema = z.object({
  name: z.string(),
  status: z.string(),
  me: z.object({ id: z.string().optional(), pushName: z.string().nullable().optional() }).nullish(),
});

const qrCodeResponseSchema = z.object({
  mimetype: z.string(),
  data: z.string(),
});

const recipientResponseSchema = z.object({
  numberExists: z.boolean(),
  chatId: z.string().nullable().optional(),
});

/**
 * The shapes the send endpoint has actually been observed to return.
 *
 * The engine decides which one. NOWEB answers with a Baileys key object, older
 * documentation and the WEBJS engine describe a flat or serialized identifier,
 * and the platform has to read all of them — the alternative is a parser that
 * rejects a message the provider already sent.
 *
 * Whichever arrives is reduced to the identifier the acknowledgements will use,
 * because the send and the receipt do not otherwise agree on the string.
 */
const messageIdentifier = z.string().min(1);
const keyShape = z.object({ key: z.object({ id: messageIdentifier }) });
const flatShape = z.object({ id: messageIdentifier });
const serializedShape = z.object({ id: z.object({ _serialized: messageIdentifier }) });

const sentMessageResponseSchema = z.union([
  keyShape.transform((value) => value.key.id),
  flatShape.transform((value) => value.id),
  serializedShape.transform((value) => value.id._serialized),
]);

interface RequestOptions {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly path: string;
  readonly body?: unknown;
  readonly abortSignal?: AbortSignal;
  readonly acceptJson?: boolean;
}

function toPhoneNumber(providerIdentifier: string | undefined): string | null {
  if (providerIdentifier === undefined) {
    return null;
  }
  const [digits] = providerIdentifier.split('@', 1);

  return digits === undefined || digits.length === 0 ? null : `+${digits}`;
}

export class WahaProvider implements WhatsAppProviderPort {
  private readonly options: WahaProviderOptions;

  public constructor(options: WahaProviderOptions) {
    this.options = options;
  }

  private async requestSession(options: RequestOptions): Promise<ProviderResult<ProviderSession>> {
    const response = await this.request(options);

    if (response.outcome === 'failed') {
      return failed(response.failure);
    }
    return this.parseSession(response.value);
  }

  private parseSession(value: unknown): ProviderResult<ProviderSession> {
    const parsed = sessionResponseSchema.safeParse(value);

    if (!parsed.success) {
      return failed(
        createProviderFailure('provider_unknown_error', 'The session response was unrecognised.'),
      );
    }

    return succeeded({
      name: parsed.data.name,
      status: toProviderSessionStatus(parsed.data.status),
      phoneNumber: toPhoneNumber(parsed.data.me?.id),
      pushName: parsed.data.me?.pushName ?? null,
    });
  }

  private async request(options: RequestOptions): Promise<ProviderResult<unknown>> {
    const timeoutSignal = AbortSignal.timeout(this.options.requestTimeoutMilliseconds);
    const signal =
      options.abortSignal === undefined
        ? timeoutSignal
        : AbortSignal.any([timeoutSignal, options.abortSignal]);

    const headers: Record<string, string> = { 'x-api-key': this.options.apiKey };
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (options.acceptJson === true) {
      // Without this the provider returns raw image bytes rather than a JSON
      // envelope, and the response cannot be handed to a browser as data.
      headers.accept = 'application/json';
    }

    try {
      const response = await fetch(new URL(options.path, this.options.baseUrl), {
        method: options.method,
        headers,
        signal,
        ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
      });

      if (!response.ok) {
        const message = await readErrorMessage(response);
        return failed(classifyHttpStatus(response.status, message, response.headers));
      }

      const text = await response.text();
      return succeeded(text.length === 0 ? undefined : (JSON.parse(text) as unknown));
    } catch (error: unknown) {
      const wasAborted = options.abortSignal?.aborted ?? false;
      return failed(classifyTransportError(error, wasAborted));
    }
  }

  public async createSession(input: CreateSessionInput): Promise<ProviderResult<ProviderSession>> {
    return this.requestSession({
      method: 'POST',
      path: '/api/sessions',
      body: {
        name: input.sessionName,
        start: input.start,
        config: {
          // Configured per session rather than globally, so each tenant gets
          // its own callback URL and signing key and either can be rotated
          // without restarting the provider.
          webhooks: [
            {
              url: input.webhookUrl,
              events: [...(this.options.webhookEvents ?? DEFAULT_WEBHOOK_EVENTS)],
              hmac: { key: input.webhookSigningKey },
              retries: { policy: 'exponential', attempts: 5, delaySeconds: 2 },
            },
          ],
        },
      },
    });
  }

  public async getSession(
    sessionName: string,
  ): Promise<ProviderResult<ProviderSession | undefined>> {
    const response = await this.request({
      method: 'GET',
      path: `/api/sessions/${encodeURIComponent(sessionName)}`,
    });

    if (response.outcome === 'failed') {
      // A missing session is an answer, not a failure: the platform uses it to
      // decide between creating and starting.
      if (response.failure.providerStatusCode === 404) {
        return succeeded(undefined);
      }
      return failed(response.failure);
    }

    return this.parseSession(response.value);
  }

  public async startSession(sessionName: string): Promise<ProviderResult<ProviderSession>> {
    return this.requestSession({
      method: 'POST',
      path: `/api/sessions/${encodeURIComponent(sessionName)}/start`,
    });
  }

  public async stopSession(sessionName: string): Promise<ProviderResult<ProviderSession>> {
    return this.requestSession({
      method: 'POST',
      path: `/api/sessions/${encodeURIComponent(sessionName)}/stop`,
    });
  }

  public async logoutSession(sessionName: string): Promise<ProviderResult<ProviderSession>> {
    return this.requestSession({
      method: 'POST',
      path: `/api/sessions/${encodeURIComponent(sessionName)}/logout`,
    });
  }

  public async deleteSession(sessionName: string): Promise<ProviderResult<void>> {
    const response = await this.request({
      method: 'DELETE',
      path: `/api/sessions/${encodeURIComponent(sessionName)}`,
    });

    if (response.outcome === 'failed') {
      return failed(response.failure);
    }
    return succeeded(undefined);
  }

  public async getQrCode(sessionName: string): Promise<ProviderResult<ProviderQrCode>> {
    const response = await this.request({
      method: 'GET',
      path: `/api/${encodeURIComponent(sessionName)}/auth/qr`,
      acceptJson: true,
    });

    if (response.outcome === 'failed') {
      return failed(response.failure);
    }

    const parsed = qrCodeResponseSchema.safeParse(response.value);
    if (!parsed.success) {
      return failed(
        createProviderFailure('provider_unknown_error', 'The QR code response was unrecognised.'),
      );
    }

    return succeeded({ mimeType: parsed.data.mimetype, data: parsed.data.data });
  }

  public async resolveRecipient(
    sessionName: string,
    phoneNumber: string,
  ): Promise<ProviderResult<ResolvedRecipient>> {
    const digits = phoneNumber.replaceAll(/\D/g, '');
    const response = await this.request({
      method: 'GET',
      path: `/api/contacts/check-exists?phone=${encodeURIComponent(digits)}&session=${encodeURIComponent(sessionName)}`,
    });

    if (response.outcome === 'failed') {
      // Distinguished from a recipient that is genuinely not on WhatsApp: this
      // one is retryable, that one is permanent.
      return failed(
        createProviderFailure('recipient_check_failed', response.failure.message, {
          ...(response.failure.providerStatusCode !== undefined && {
            providerStatusCode: response.failure.providerStatusCode,
          }),
        }),
      );
    }

    const parsed = recipientResponseSchema.safeParse(response.value);
    if (!parsed.success) {
      return failed(
        createProviderFailure('recipient_check_failed', 'The recipient lookup was unrecognised.'),
      );
    }

    return succeeded({
      isRegistered: parsed.data.numberExists,
      chatIdentifier: parsed.data.chatId ?? null,
    });
  }

  public async sendTextMessage(input: SendTextMessageInput): Promise<ProviderResult<SentMessage>> {
    const response = await this.request({
      method: 'POST',
      path: '/api/sendText',
      body: {
        session: input.sessionName,
        chatId: input.chatIdentifier,
        text: input.text,
        linkPreview: false,
      },
      ...(input.abortSignal !== undefined && { abortSignal: input.abortSignal }),
    });

    if (response.outcome === 'failed') {
      return failed(response.failure);
    }

    const parsed = sentMessageResponseSchema.safeParse(response.value);
    if (!parsed.success) {
      // Accepted, and unreadable. The message was almost certainly sent, so
      // this is an unknown outcome rather than a failure to retry blindly.
      return failed(
        createProviderFailure(
          'provider_response_unreadable',
          'The provider accepted the message and answered in a shape this version cannot read.',
        ),
      );
    }

    return succeeded({ providerMessageId: normalizeProviderMessageId(parsed.data) });
  }

  public async isReachable(): Promise<boolean> {
    try {
      const response = await fetch(new URL('/ping', this.options.baseUrl), {
        signal: AbortSignal.timeout(this.options.requestTimeoutMilliseconds),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length === 0 ? response.statusText : text.slice(0, 500);
  } catch {
    return response.statusText;
  }
}
