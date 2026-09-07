import { createHmac, randomUUID } from 'node:crypto';

import { type WebhookConfiguration } from './session-store';

export interface WebhookEnvelope {
  readonly id: string;
  readonly timestamp: number;
  readonly session: string;
  readonly event: string;
  readonly payload: Record<string, unknown>;
  readonly engine: string;
  readonly environment: { readonly tier: string; readonly version: string };
  readonly me: { readonly id: string; readonly pushName: string } | null;
}

export interface DeliveredWebhook {
  readonly url: string;
  readonly envelope: WebhookEnvelope;
  readonly statusCode: number | null;
  readonly error: string | null;
}

/**
 * Signs the exact bytes that are sent.
 *
 * The receiver has to verify against the raw body too: re-serialising the
 * parsed object would change key order or spacing and produce a different
 * digest, which is the classic way HMAC verification silently starts failing.
 */
export function signPayload(rawBody: string, key: string): string {
  return createHmac('sha512', key).update(rawBody).digest('hex');
}

export class WebhookSender {
  private readonly delivered: DeliveredWebhook[] = [];

  private async deliver(webhook: WebhookConfiguration, envelope: WebhookEnvelope): Promise<void> {
    const rawBody = JSON.stringify(envelope);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-webhook-request-id': randomUUID(),
      'x-webhook-timestamp': String(envelope.timestamp),
    };

    const signingKey = webhook.hmac?.key;
    if (signingKey !== undefined && signingKey.length > 0) {
      headers['x-webhook-hmac'] = signPayload(rawBody, signingKey);
      headers['x-webhook-hmac-algorithm'] = 'sha512';
    }

    try {
      const response = await fetch(webhook.url, { method: 'POST', headers, body: rawBody });
      this.delivered.push({
        url: webhook.url,
        envelope,
        statusCode: response.status,
        error: null,
      });
    } catch (error: unknown) {
      // A receiver being down must not take the stub with it; the delivery is
      // recorded as failed so a test can assert on it.
      this.delivered.push({
        url: webhook.url,
        envelope,
        statusCode: null,
        error: error instanceof Error ? error.message : 'unknown error',
      });
    }
  }

  public async send(
    webhooks: readonly WebhookConfiguration[],
    sessionName: string,
    event: string,
    payload: Record<string, unknown>,
    me: { readonly id: string; readonly pushName: string } | null,
  ): Promise<void> {
    const envelope: WebhookEnvelope = {
      id: randomUUID(),
      timestamp: Date.now(),
      session: sessionName,
      event,
      payload,
      engine: 'NOWEB',
      environment: { tier: 'CORE', version: 'stub' },
      me,
    };

    const subscribed = webhooks.filter(
      (webhook) => webhook.events.includes(event) || webhook.events.includes('*'),
    );

    await Promise.all(subscribed.map(async (webhook) => this.deliver(webhook, envelope)));
  }

  public recentDeliveries(): readonly DeliveredWebhook[] {
    return this.delivered;
  }

  public clear(): void {
    this.delivered.length = 0;
  }
}
