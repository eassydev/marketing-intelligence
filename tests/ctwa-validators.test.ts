import { describe, it, expect } from 'vitest';
import { touchIngestSchema, conversionIngestSchema } from '../src/marketing/ingest/validators.js';

const WA_HASH = 'a'.repeat(64); // valid sha256 hex shape
const CTWA_TOUCH = {
  app: 'services',
  channel: 'ctwa',
  session_id: 'wa-wamid.HBgLOTE5ODc2NTQzMjEw',
  ctwa_clid: 'ARAkLkA8rmlFeiCktEJQ-QTwrcnZ9M4d37Qy',
  wa_phone_hash: WA_HASH,
  raw: { referral: { source_type: 'ad', source_id: '1234567890' }, lead_id: 987 },
};

describe('touchIngestSchema (CTWA)', () => {
  it('accepts the BackendNew CTWA payload', () => {
    const t = touchIngestSchema.parse(CTWA_TOUCH);
    expect(t.channel).toBe('ctwa');
    expect(t.ctwa_clid).toBe(CTWA_TOUCH.ctwa_clid);
    expect(t.wa_phone_hash).toBe(WA_HASH);
    expect(t.raw).toEqual(CTWA_TOUCH.raw);
  });

  it('keeps ctwa fields optional — a plain web touch still parses', () => {
    const t = touchIngestSchema.parse({ app: 'services', session_id: 's1', gclid: 'g1' });
    expect(t.ctwa_clid).toBeUndefined();
    expect(t.wa_phone_hash).toBeUndefined();
    expect(t.channel).toBeUndefined();
  });

  it('rejects a wa_phone_hash that is not 64 lowercase hex chars', () => {
    for (const bad of ['deadbeef', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63)]) {
      expect(() => touchIngestSchema.parse({ ...CTWA_TOUCH, wa_phone_hash: bad })).toThrow();
    }
  });

  it('rejects an unknown channel and an oversized ctwa_clid', () => {
    expect(() => touchIngestSchema.parse({ ...CTWA_TOUCH, channel: 'tiktok' })).toThrow();
    expect(() =>
      touchIngestSchema.parse({ ...CTWA_TOUCH, ctwa_clid: 'x'.repeat(513) }),
    ).toThrow();
  });
});

const CTWA_CONVERSION = {
  app: 'services',
  order_id: 'O-ctwa-1',
  value_inr: 999,
  is_first_order: true,
  occurred_at: '2026-07-10T10:00:00.000Z',
  action_source: 'business_messaging',
  messaging_channel: 'whatsapp',
  ctwa_clid: 'ARAkLkA8rmlFeiCktEJQ-QTwrcnZ9M4d37Qy',
};

describe('conversionIngestSchema (CTWA)', () => {
  it('accepts business_messaging + messaging_channel + ctwa_clid', () => {
    const c = conversionIngestSchema.parse(CTWA_CONVERSION);
    expect(c.action_source).toBe('business_messaging');
    expect(c.messaging_channel).toBe('whatsapp');
    expect(c.ctwa_clid).toBe(CTWA_CONVERSION.ctwa_clid);
  });

  it('still defaults action_source to app and leaves ctwa fields optional', () => {
    const c = conversionIngestSchema.parse({
      app: 'services',
      order_id: 'O2',
      value_inr: 100,
      is_first_order: false,
      occurred_at: '2026-07-10T10:00:00.000Z',
    });
    expect(c.action_source).toBe('app');
    expect(c.ctwa_clid).toBeUndefined();
    expect(c.messaging_channel).toBeUndefined();
  });

  it('rejects a messaging_channel other than whatsapp', () => {
    expect(() =>
      conversionIngestSchema.parse({ ...CTWA_CONVERSION, messaging_channel: 'sms' }),
    ).toThrow();
  });
});
