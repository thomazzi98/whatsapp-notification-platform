import { type WhatsAppSessionResponse } from '@platform/contracts';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiMock } from '../../testing/api-mock';
import { expectNoAccessibilityViolations, renderScreen } from '../../testing/render';
import { QrPanel } from './qr-panel';

const APPLICATION_ID = '00000000-0000-7000-8000-000000000001';
const CONNECTION_ID = '00000000-0000-7000-8000-0000000000aa';

const baseConnection: WhatsAppSessionResponse = {
  id: CONNECTION_ID,
  displayName: 'Support line',
  status: 'SCAN_QR_CODE',
  phoneNumber: null,
  pushName: null,
  lastError: null,
  lastStatusAt: '2026-09-08T10:00:00.000Z',
  createdAt: '2026-09-08T10:00:00.000Z',
};

/** A one-pixel PNG: enough for an element that has to be a real image. */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function codeIsAvailable(): void {
  apiMock.use(
    http.get(
      `*/dashboard/applications/${APPLICATION_ID}/whatsapp-sessions/${CONNECTION_ID}/qr-code`,
      () => HttpResponse.json({ mimeType: 'image/png', data: TINY_PNG }),
    ),
  );
}

function renderPanel(connection: WhatsAppSessionResponse): ReturnType<typeof renderScreen> {
  return renderScreen(<QrPanel applicationId={APPLICATION_ID} connection={connection} />);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the connect screen', () => {
  it('shows the code while the provider is waiting for a scan', async () => {
    codeIsAvailable();
    renderPanel(baseConnection);

    expect(
      await screen.findByRole('img', { name: /QR code for linking a WhatsApp account/ }),
    ).toBeInTheDocument();
  });

  it('never says connected before the provider says so', async () => {
    codeIsAvailable();
    renderPanel(baseConnection);
    await screen.findByRole('img', { name: /QR code/ });

    expect(screen.queryByText(/Paired with/)).not.toBeInTheDocument();
    expect(screen.getByText(/Waiting for the scan/)).toBeInTheDocument();
  });

  it('says who it paired with once the provider reports it working', () => {
    renderPanel({
      ...baseConnection,
      status: 'WORKING',
      phoneNumber: '+5511999990000',
      pushName: 'Support',
    });

    expect(screen.getByText('+5511999990000')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /QR code/ })).not.toBeInTheDocument();
  });

  it('asks for no code at all while the tab is in the background', async () => {
    // The provider issues a handful of codes before the connection fails
    // outright, so a code fetched by a tab nobody is watching is an attempt
    // spent for nothing.
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    codeIsAvailable();

    renderPanel(baseConnection);

    expect(await screen.findByText('Paused')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('img', { name: /QR code/ })).not.toBeInTheDocument();
    });
  });

  it('offers no code for a connection that has nothing to scan', () => {
    renderPanel({ ...baseConnection, status: 'STOPPED' });

    expect(screen.getByText(/Start the connection to bring it back up/)).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /QR code/ })).not.toBeInTheDocument();
  });

  it('says the provider could not produce a code rather than showing nothing', async () => {
    apiMock.use(
      http.get(
        `*/dashboard/applications/${APPLICATION_ID}/whatsapp-sessions/${CONNECTION_ID}/qr-code`,
        () =>
          HttpResponse.json(
            {
              type: 'about:blank',
              title: 'Bad Gateway',
              status: 502,
              detail: 'The WhatsApp provider could not produce a code.',
            },
            { status: 502 },
          ),
      ),
    );

    renderPanel(baseConnection);

    expect(await screen.findByText('No code available')).toBeInTheDocument();
  });

  it('has no accessibility violations while waiting for a scan', async () => {
    codeIsAvailable();
    const { container } = renderPanel(baseConnection);
    await screen.findByRole('img', { name: /QR code/ });

    await expectNoAccessibilityViolations(container);
  });
});
