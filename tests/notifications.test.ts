import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';

// Configure WhatsApp env BEFORE importing the modules (env is read at import).
let assertAllowed: (to: string) => void;
let WhatsAppNotifier: typeof import('../src/notifications/whatsapp-notifier.js')['WhatsAppNotifier'];

beforeAll(async () => {
  process.env.WHATSAPP_RECIPIENT_ALLOWLIST = '+919900000000';
  process.env.WHATSAPP_TOKEN = 'test-token';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '123456';
  ({ assertAllowed } = await import('../src/notifications/allowlist.js'));
  ({ WhatsAppNotifier } = await import('../src/notifications/whatsapp-notifier.js'));
});

afterEach(() => vi.unstubAllGlobals());

describe('allowlist', () => {
  it('rejects a recipient not on the allowlist', () => {
    expect(() => assertAllowed('+910000000000')).toThrow(/allowlist/i);
  });
  it('permits an allowlisted recipient', () => {
    expect(() => assertAllowed('+919900000000')).not.toThrow();
  });
});

describe('WhatsAppNotifier', () => {
  it('posts a template message and returns the provider id', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: 'wamid.123' }] }),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const notifier = new WhatsAppNotifier();
    const res = await notifier.sendTemplate('+919900000000', {
      name: 'mil_alert_v1',
      language: 'en',
      params: ['Mumbai', 'CPA spike'],
    });

    expect(res).toEqual({ success: true, providerMessageId: 'wamid.123' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/123456/messages');
    const body = JSON.parse(init.body as string);
    expect(body.type).toBe('template');
    expect(body.template.components[0].parameters).toHaveLength(2);
  });

  it('refuses an unlisted recipient before any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const notifier = new WhatsAppNotifier();
    await expect(notifier.sendText('+910000000000', 'hi')).rejects.toThrow(/allowlist/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
