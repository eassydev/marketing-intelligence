import { describe, it, expect } from 'vitest';
import { touchIngestSchema } from '../src/marketing/ingest/validators.js';

describe('touchIngestSchema (touch_type)', () => {
  it("defaults touch_type to 'touch' when absent", () => {
    const t = touchIngestSchema.parse({ app: 'services', session_id: 's1', gclid: 'g1' });
    expect(t.touch_type).toBe('touch');
  });

  it('accepts first_party_click and lead (BackendNew click worker / lead ingest)', () => {
    for (const touch_type of ['first_party_click', 'lead'] as const) {
      const t = touchIngestSchema.parse({
        app: 'services',
        session_id: 'click-abc123',
        touch_type,
        utm_campaign: 'blr_society_qr',
        raw: { slug: 'abc123', link_id: 7 },
      });
      expect(t.touch_type).toBe(touch_type);
    }
  });

  it('rejects an unknown touch_type', () => {
    expect(() =>
      touchIngestSchema.parse({ app: 'services', session_id: 's1', touch_type: 'view' }),
    ).toThrow();
  });
});
