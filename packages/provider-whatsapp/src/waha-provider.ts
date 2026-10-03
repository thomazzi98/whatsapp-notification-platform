import { setTimeout as delay } from 'node:timers/promises';

import {
  type AccountLimits,
  createProviderFailure,
  type CreateSessionInput,
  failed,
  type ProviderQrCode,
  type ProviderResult,
  type ProviderSession,
  isRetryable,
  normalizeProviderMessageId,
  type ResolvedRecipient,
  type SendTextMessageInput,
  type SentMessage,
  type ShowTypingInput,
  succeeded,
  toProviderSessionStatus,
  type WhatsAppProviderPort,
} from '@platform/domain';
import { z } from 'zod';

import { readAccountLimits, readNewChatQuota, readReachoutTimelock } from './account-limits';
import { classifyHttpStatus, classifyTransportError } from './classify-failure';

export interface WahaProviderOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly requestTimeoutMilliseconds: number;
  /** Waits out the typing indicator. Injected so a test need not wait for real. */
  readonly sleep?: (milliseconds: number, abortSignal?: AbortSignal) => Promise<void>;
}

/** Ends early when aborted, which is all an abort means for a wait. */
async function sleepUnlessAborted(milliseconds: number, abortSignal?: AbortSignal): Promise<void> {
  try {
    await delay(milliseconds, undefined, abortSignal === undefined ? {} : { signal: abortSignal });
  } catch {
    // Aborted: the wait is over, and nothing else depended on it.
  }
}

const DEFAULT_WEBHOOK_EVENTS = ['session.status', 'message.ack', 'state.change'] as const;

const sessionResponseSchema = z.object({
  name: z.string(),
  status: z.string(),
  me: z
    .object({
      id: z.string().optional(),
      pushName: z.string().nullable().optional(),
      // What the engine last heard from WhatsApp about the account's limits,
      // read by readAccountLimits rather than here.
      reachoutTimelock: z.unknown().optional(),
      messageCapping: z.unknown().optional(),
    })
    .nullish(),
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
  private readonly sleep: (milliseconds: number, abortSignal?: AbortSignal) => Promise<void>;

  public constructor(options: WahaProviderOptions) {
    this.options = options;
    this.sleep = options.sleep ?? sleepUnlessAborted;
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

    const me = parsed.data.me;

    return succeeded({
      name: parsed.data.name,
      status: toProviderSessionStatus(parsed.data.status),
      phoneNumber: toPhoneNumber(me?.id),
      pushName: me?.pushName ?? null,
      // An unpaired session has no account, and so nothing to report about it.
      accountLimits: me === null || me === undefined ? null : readAccountLimits(me),
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
              events: [...DEFAULT_WEBHOOK_EVENTS],
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

  /**
   * WAHA answers start on a FAILED session -- one whose six codes expired
   * unscanned -- with a 201 that changes nothing. Stopping it first is what
   * gets a fresh round of codes; without that, the only way back from a slow
   * scan was deleting the connection.
   */
  public async startSession(sessionName: string): Promise<ProviderResult<ProviderSession>> {
    const path = `/api/sessions/${encodeURIComponent(sessionName)}`;
    const started = await this.requestSession({ method: 'POST', path: `${path}/start` });

    if (started.outcome === 'failed' || started.value.status !== 'FAILED') {
      return started;
    }

    const stopped = await this.requestSession({ method: 'POST', path: `${path}/stop` });
    if (stopped.outcome === 'failed') {
      return stopped;
    }
    return this.requestSession({ method: 'POST', path: `${path}/start` });
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
      // A permanent failure keeps the code it was classified with. Relabelling
      // everything here as retryable meant a rejected API key or a missing
      // session -- both hopeless without a human -- were retried on the lookup
      // for the whole delivery window instead of failing at the first attempt.
      if (!isRetryable(response.failure)) {
        return failed(response.failure);
      }

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

  /**
   * Both lookups ask WhatsApp afresh. An engine whose WhatsApp Web build cannot
   * read one of them answers 501 for it, which leaves that half unknown rather
   * than failing the other; only when neither answers is the lookup a failure.
   */
  public async fetchAccountLimits(sessionName: string): Promise<ProviderResult<AccountLimits>> {
    const path = `/api/sessions/${encodeURIComponent(sessionName)}`;
    const timelock = await this.request({ method: 'GET', path: `${path}/timelock` });
    const capping = await this.request({ method: 'GET', path: `${path}/capping` });

    if (timelock.outcome === 'failed' && capping.outcome === 'failed') {
      return failed(timelock.failure);
    }

    return succeeded({
      reachoutTimelock:
        timelock.outcome === 'succeeded' ? readReachoutTimelock(timelock.value) : null,
      newChatQuota: capping.outcome === 'succeeded' ? readNewChatQuota(capping.value) : null,
    });
  }

  /**
   * The sequence WAHA recommends before a message: mark the chat seen, show
   * typing for as long as the text would take to write, then stop.
   *
   * Seen is best effort and ignored when it fails: a chat with nothing unread,
   * or one WhatsApp Web has not loaded yet, has nothing to mark. Typing that
   * cannot start is reported, and the wait is skipped, because there is no
   * indicator to keep up. Stopping is attempted even after an abort, so a
   * worker that is shutting down does not leave "typing…" on someone's screen.
   */
  public async showTyping(input: ShowTypingInput): Promise<ProviderResult<void>> {
    const chat = { session: input.sessionName, chatId: input.chatIdentifier };
    const abort = input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal };

    await this.request({ method: 'POST', path: '/api/sendSeen', body: chat, ...abort });

    const started = await this.request({
      method: 'POST',
      path: '/api/startTyping',
      body: chat,
      ...abort,
    });
    if (started.outcome === 'failed') {
      return failed(started.failure);
    }

    await this.sleep(input.durationMilliseconds, input.abortSignal);

    const stopped = await this.request({ method: 'POST', path: '/api/stopTyping', body: chat });
    if (stopped.outcome === 'failed') {
      return failed(stopped.failure);
    }
    return succeeded(undefined);
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
}

/** Validation failures carry a list of messages rather than one. */
const errorTextSchema = z.union([
  z.string().min(1),
  z.array(z.string()).transform((messages) => messages.join('; ')),
]);

const errorBodySchema = z.object({
  exception: z.object({ message: errorTextSchema }).optional(),
  message: errorTextSchema.optional(),
});

/** Anything that names a chat or an account, in any of WhatsApp's address forms. */
const CHAT_ADDRESS_PATTERN =
  /[\w.-]*\d[\w.-]*@(?:c\.us|s\.whatsapp\.net|lid|g\.us|newsletter|broadcast)/g;

const MAXIMUM_ERROR_MESSAGE_LENGTH = 200;

/**
 * The provider's own account of what went wrong, and nothing else.
 *
 * WAHA answers an engine failure with the error, its stack, and the request
 * that caused it echoed back — chat identifier and message text included —
 * and the failure message ends up in the reason the public API returns. Only
 * the error's message is kept, with any chat address in it masked.
 */
async function readErrorMessage(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (text.length === 0) {
      return response.statusText;
    }
    return toSafeErrorMessage(text) ?? response.statusText;
  } catch {
    return response.statusText;
  }
}

function toSafeErrorMessage(text: string): string | undefined {
  const message = readMessage(text);
  if (message === undefined) {
    return undefined;
  }

  const safe = message.replaceAll(CHAT_ADDRESS_PATTERN, 'a chat').replaceAll(/\s+/g, ' ').trim();
  return safe.length === 0 ? undefined : safe.slice(0, MAXIMUM_ERROR_MESSAGE_LENGTH);
}

/**
 * A JSON body yields its message field or nothing: whatever else it holds is
 * the echo this exists to drop. Anything that is not JSON — a proxy's error
 * page, plain text — is used as it came, masked like the rest.
 */
function readMessage(text: string): string | undefined {
  try {
    const parsed = errorBodySchema.safeParse(JSON.parse(text));
    return parsed.success ? (parsed.data.exception?.message ?? parsed.data.message) : undefined;
  } catch {
    return text;
  }
}
