import { describe, expect, it } from 'vitest';

import {
  canSessionSend,
  isSessionConnecting,
  providerSessionStatuses,
} from './whatsapp-provider.port';

describe('what a connection can do in each state', () => {
  it('sends only when WhatsApp reports it working', () => {
    const sending = providerSessionStatuses.filter((status) => canSessionSend(status));

    expect(sending).toStrictEqual(['WORKING']);
  });

  it('counts a connection being paired as on its way, and nothing else', () => {
    const connecting = providerSessionStatuses.filter((status) => isSessionConnecting(status));

    expect(connecting).toStrictEqual(['STARTING', 'SCAN_QR_CODE']);
  });

  it('never calls a connection both able to send and still connecting', () => {
    for (const status of providerSessionStatuses) {
      expect(canSessionSend(status) && isSessionConnecting(status), status).toBe(false);
    }
  });
});
