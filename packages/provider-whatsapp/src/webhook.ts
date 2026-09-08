import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  type ProviderEvent,
  toDeliveryAcknowledgement,
  toProviderSessionStatus,
} from '@platform/domain';
import { z } from 'zod';

export const WEBHOOK_SIGNATURE_HEADER = 'x-webhook-hmac';
export const WEBHOOK_TIMESTAMP_HEADER = 'x-webhook-timestamp';

const SIGNATURE_ALGORITHM = 'sha512';

/**
 * The provider's callback envelope, parsed permissively.
 *
 * Only the fields the platform acts on are required. A newer provider release
 * that adds keys, or an event whose payload the platform does not understand,
 * has to remain ingestable: refusing it would drop delivery receipts for
 * messages that were genuinely sent.
 */
const envelopeSchema = z.object({
  id: z.string().min(1),
  timestamp: z.number().optional(),
  session: z.string().min(1),
  event: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
  me: z.object({ id: z.string().optional(), pushName: z.string().nullable().optional() }).nullish(),
});

export type WebhookEnvelope = z.infer<typeof envelopeSchema>;

const acknowledgementPayloadSchema = z.object({
  id: z.string().min(1),
  ack: z.number(),
  fromMe: z.boolean().optional(),
});

const sessionStatusPayloadSchema = z.object({
  name: z.string().optional(),
  status: z.string(),
});

export function parseWebhookEnvelope(body: unknown): WebhookEnvelope | undefined {
  const parsed = envelopeSchema.safeParse(body);

  return parsed.success ? parsed.data : undefined;
}

function toPhoneNumber(providerIdentifier: string | undefined): string | null {
  if (providerIdentifier === undefined) {
    return null;
  }
  const [digits] = providerIdentifier.split('@', 1);

  return digits === undefined || digits.length === 0 ? null : `+${digits}`;
}

/**
 * Translates one provider envelope into the platform's own vocabulary.
 *
 * Anything unrecognised — a new event type, a payload that does not match the
 * shape this version knows — becomes `unsupported` rather than an error. The
 * delivery is still recorded, so a provider upgrade shows up as events the
 * platform skipped rather than as ingestion failures.
 */
export function toProviderEvent(envelope: WebhookEnvelope): ProviderEvent {
  if (envelope.event === 'message.ack') {
    const payload = acknowledgementPayloadSchema.safeParse(envelope.payload);
    if (!payload.success) {
      return { kind: 'unsupported', eventType: envelope.event };
    }

    const acknowledgement = toDeliveryAcknowledgement(payload.data.ack);
    if (acknowledgement === undefined) {
      return { kind: 'unsupported', eventType: envelope.event };
    }

    return {
      kind: 'message_acknowledgement',
      providerMessageId: payload.data.id,
      acknowledgement,
      // Absent means outbound: the provider only omits the flag on the engine
      // builds where every acknowledgement concerns a message we sent.
      fromUs: payload.data.fromMe ?? true,
    };
  }

  if (envelope.event === 'session.status' || envelope.event === 'state.change') {
    const payload = sessionStatusPayloadSchema.safeParse(envelope.payload);
    if (!payload.success) {
      return { kind: 'unsupported', eventType: envelope.event };
    }

    return {
      kind: 'session_status',
      sessionName: payload.data.name ?? envelope.session,
      status: toProviderSessionStatus(payload.data.status),
      phoneNumber: toPhoneNumber(envelope.me?.id),
      pushName: envelope.me?.pushName ?? null,
    };
  }

  return { kind: 'unsupported', eventType: envelope.event };
}

/**
 * Verifies the signature over the exact bytes that arrived.
 *
 * Re-serialising the parsed body would change key order or spacing and produce
 * a different digest, which is the classic way HMAC verification starts failing
 * for reasons nobody can reproduce. The comparison is constant time so a
 * caller cannot learn the expected digest one byte at a time.
 */
export function isWebhookSignatureValid(
  rawBody: Buffer,
  suppliedSignature: string,
  signingKey: string,
): boolean {
  const expected = Buffer.from(
    createHmac(SIGNATURE_ALGORITHM, signingKey).update(rawBody).digest('hex'),
  );
  const supplied = Buffer.from(suppliedSignature);

  if (supplied.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(supplied, expected);
}

/**
 * Rejects a callback whose timestamp is too far from now.
 *
 * A signature stays valid forever, so without this a captured request could be
 * replayed at any point in the future. Callbacks with no timestamp are accepted
 * because the inbox already rejects a repeated event identifier.
 */
export function isWebhookTimestampAcceptable(
  timestampHeader: string | undefined,
  now: Date,
  toleranceSeconds: number,
): boolean {
  if (timestampHeader === undefined || timestampHeader.length === 0) {
    return true;
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) {
    return false;
  }

  // The provider sends milliseconds; a value small enough to be seconds is
  // treated as such rather than as a timestamp from 1970.
  const milliseconds = timestamp < 100_000_000_000 ? timestamp * 1000 : timestamp;

  return Math.abs(now.getTime() - milliseconds) <= toleranceSeconds * 1000;
}
