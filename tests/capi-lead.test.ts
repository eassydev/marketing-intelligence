import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  buildLeadEvent,
  buildPurchaseEvent,
  type ConversionRow,
} from '../src/marketing/capi/meta-capi.js';
import { leadEventIngestSchema } from '../src/marketing/ingest/validators.js';

const expectHash = (v: string) =>
  crypto.createHash('sha256').update(v.trim().toLowerCase()).digest('hex');

const WA_HASH = 'a'.repeat(64);
const CTWA_CLID = 'ARAkLkA8rmlFeiCktEJQ-QTwrcnZ9M4d37Qy';

const baseRow: ConversionRow = {
  orderId: 'ORD-9',
  userId: 42,
  valueInr: '999.00',
  occurredAt: new Date('2026-07-01T10:00:00Z'),
  actionSource: 'business_messaging',
  city: 'Bangalore',
  fbc: null,
  fbp: null,
};

describe('buildPurchaseEvent (CTWA / business_messaging)', () => {
  it('wraps a ctwa_clid purchase in the business_messaging envelope', () => {
    const e = buildPurchaseEvent({ ...baseRow, ctwaClid: CTWA_CLID });
    expect(e.event_name).toBe('Purchase');
    expect(e.action_source).toBe('business_messaging');
    expect(e.messaging_channel).toBe('whatsapp');
    expect(e.user_data.ctwa_clid).toBe(CTWA_CLID); // RAW, never hashed
    // Dedup + hashing rules unchanged.
    expect(e.event_id).toBe('ORD-9');
    expect(e.user_data.external_id).toEqual([expectHash('42')]);
    expect(e.user_data.ct).toEqual([expectHash('bangalore')]);
    expect(e.custom_data).toEqual({ value: 999, currency: 'INR' });
  });

  it('leaves non-CTWA purchases on the website/app envelope', () => {
    const e = buildPurchaseEvent({ ...baseRow, actionSource: 'app', ctwaClid: null });
    expect(e.action_source).toBe('app');
    expect(e.messaging_channel).toBeUndefined();
    expect(e.user_data.ctwa_clid).toBeUndefined();
  });
});

describe('buildLeadEvent', () => {
  it('builds a business_messaging Lead with lead-<ctwa_clid> dedup id', () => {
    const e = buildLeadEvent({
      ctwaClid: CTWA_CLID,
      waPhoneHash: WA_HASH,
      occurredAt: new Date('2026-07-01T09:30:00Z'),
    });
    expect(e.event_name).toBe('Lead');
    expect(e.event_id).toBe(`lead-${CTWA_CLID}`);
    expect(e.event_time).toBe(Math.floor(new Date('2026-07-01T09:30:00Z').getTime() / 1000));
    expect(e.action_source).toBe('business_messaging');
    expect(e.messaging_channel).toBe('whatsapp');
    expect(e.user_data.ctwa_clid).toBe(CTWA_CLID); // RAW
    // wa_phone_hash is already sha256 of the digits-only phone — forwarded as ph, not re-hashed.
    expect(e.user_data.ph).toEqual([WA_HASH]);
    expect(e.custom_data).toBeUndefined(); // Lead carries no value payload
  });

  it('omits ph when no phone hash is known', () => {
    const e = buildLeadEvent({
      ctwaClid: CTWA_CLID,
      waPhoneHash: null,
      occurredAt: '2026-07-01T09:30:00Z',
    });
    expect(e.user_data).toEqual({ ctwa_clid: CTWA_CLID });
  });
});

describe('leadEventIngestSchema', () => {
  it('accepts the BackendNew lead payload', () => {
    const p = leadEventIngestSchema.parse({
      app: 'services',
      ctwa_clid: CTWA_CLID,
      wa_phone_hash: WA_HASH,
      lead_ref: 'B2CL-000123',
      occurred_at: '2026-07-01T09:30:00.000Z',
    });
    expect(p.ctwa_clid).toBe(CTWA_CLID);
    expect(p.lead_ref).toBe('B2CL-000123');
  });

  it('requires ctwa_clid and leaves everything else optional', () => {
    expect(() => leadEventIngestSchema.parse({ app: 'services' })).toThrow();
    const p = leadEventIngestSchema.parse({ app: 'services', ctwa_clid: 'x' });
    expect(p.wa_phone_hash).toBeUndefined();
    expect(p.occurred_at).toBeUndefined();
  });

  it('rejects a wa_phone_hash that is not 64 lowercase hex chars', () => {
    for (const bad of ['deadbeef', 'A'.repeat(64), 'g'.repeat(64)]) {
      expect(() =>
        leadEventIngestSchema.parse({ app: 'services', ctwa_clid: 'x', wa_phone_hash: bad }),
      ).toThrow();
    }
  });
});
