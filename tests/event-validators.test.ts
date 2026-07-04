import { describe, it, expect } from 'vitest';
import { appEventSchema, eventsIngestSchema } from '../src/marketing/ingest/validators.js';
import { clampOccurredAt } from '../src/marketing/ingest/event-writer.js';

const UUID = '11111111-1111-4111-8111-111111111111';
const validEvent = {
  event_id: UUID,
  event_name: 'el_app_open',
  occurred_at: '2026-07-04T10:00:00.000Z',
};

describe('appEventSchema', () => {
  it('accepts a minimal valid event', () => {
    expect(appEventSchema.parse(validEvent)).toMatchObject({ event_name: 'el_app_open' });
  });

  it('rejects a non-uuid event_id', () => {
    expect(() => appEventSchema.parse({ ...validEvent, event_id: 'nope' })).toThrow();
  });

  it('rejects an event_name with uppercase or spaces', () => {
    expect(() => appEventSchema.parse({ ...validEvent, event_name: 'El App' })).toThrow();
    expect(() => appEventSchema.parse({ ...validEvent, event_name: 'a'.repeat(65) })).toThrow();
  });

  it('rejects a non-datetime occurred_at', () => {
    expect(() => appEventSchema.parse({ ...validEvent, occurred_at: '2026-07-04' })).toThrow();
  });

  it('rejects an invalid platform enum', () => {
    expect(() => appEventSchema.parse({ ...validEvent, platform: 'linux' })).toThrow();
    expect(appEventSchema.parse({ ...validEvent, platform: 'android' }).platform).toBe('android');
  });

  it('accepts nullish session_id/user_id/props', () => {
    const e = appEventSchema.parse({
      ...validEvent,
      session_id: 'sid1',
      user_id: 42,
      props: { screen: 'home' },
    });
    expect(e.user_id).toBe(42);
    expect(e.props).toEqual({ screen: 'home' });
  });
});

describe('eventsIngestSchema', () => {
  it('accepts a batch of 1..200 events', () => {
    const p = eventsIngestSchema.parse({ app: 'services', events: [validEvent] });
    expect(p.events).toHaveLength(1);
  });

  it('rejects an empty batch', () => {
    expect(() => eventsIngestSchema.parse({ app: 'services', events: [] })).toThrow();
  });

  it('rejects a batch over 200', () => {
    const events = Array.from({ length: 201 }, (_, i) => ({
      ...validEvent,
      event_id: `1111111${String(i).padStart(4, '0')}-1111-4111-8111-111111111111`.slice(0, 36),
    }));
    expect(() => eventsIngestSchema.parse({ app: 'services', events })).toThrow();
  });

  it('accepts an optional batch_id uuid', () => {
    const p = eventsIngestSchema.parse({ app: 'services', batch_id: UUID, events: [validEvent] });
    expect(p.batch_id).toBe(UUID);
  });
});

describe('clampOccurredAt', () => {
  const now = new Date('2026-07-04T12:00:00.000Z');

  it('leaves an in-range timestamp untouched', () => {
    const t = new Date('2026-07-01T00:00:00.000Z');
    expect(clampOccurredAt(t, now).toISOString()).toBe(t.toISOString());
  });

  it('clamps a too-old timestamp up to now-30d', () => {
    const t = new Date('2026-01-01T00:00:00.000Z');
    const clamped = clampOccurredAt(t, now);
    expect(clamped.getTime()).toBe(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  });

  it('clamps a future timestamp down to now+1h', () => {
    const t = new Date('2026-08-01T00:00:00.000Z');
    const clamped = clampOccurredAt(t, now);
    expect(clamped.getTime()).toBe(now.getTime() + 60 * 60 * 1000);
  });
});
