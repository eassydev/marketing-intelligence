import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'node:crypto';
import {
  sha256,
  buildPurchaseEvent,
  sendEvents,
  type ConversionRow,
} from '../src/marketing/capi/meta-capi.js';
import { runCapiUpload } from '../src/marketing/capi/upload-job.js';

const expectHash = (v: string) =>
  crypto.createHash('sha256').update(v.trim().toLowerCase()).digest('hex');

const baseRow: ConversionRow = {
  orderId: 'ORD-1',
  userId: 42,
  valueInr: '1500.00',
  occurredAt: new Date('2026-06-20T10:00:00Z'),
  actionSource: 'website',
  city: 'Bangalore',
  fbc: 'fb.1.123.abc',
  fbp: 'fb.1.123.xyz',
};

afterEach(() => vi.unstubAllGlobals());

describe('sha256', () => {
  it('normalizes (trim + lowercase) then hashes', () => {
    expect(sha256('  Bangalore ')).toBe(expectHash('bangalore'));
    expect(sha256('42')).toBe(expectHash('42'));
  });
});

describe('buildPurchaseEvent', () => {
  it('sets Purchase, event_id=order_id, unix seconds, INR value', () => {
    const e = buildPurchaseEvent(baseRow);
    expect(e.event_name).toBe('Purchase');
    expect(e.event_id).toBe('ORD-1'); // dedup with browser pixel
    expect(e.event_time).toBe(Math.floor(new Date('2026-06-20T10:00:00Z').getTime() / 1000));
    expect(e.custom_data).toEqual({ value: 1500, currency: 'INR' });
  });

  it('hashes external_id + ct, passes fbc/fbp RAW', () => {
    const e = buildPurchaseEvent(baseRow);
    expect(e.user_data.external_id).toEqual([expectHash('42')]);
    expect(e.user_data.ct).toEqual([expectHash('bangalore')]);
    expect(e.user_data.fbc).toBe('fb.1.123.abc');
    expect(e.user_data.fbp).toBe('fb.1.123.xyz');
  });

  it("maps action_source: 'app' → app, everything else → website", () => {
    expect(buildPurchaseEvent({ ...baseRow, actionSource: 'app' }).action_source).toBe('app');
    expect(buildPurchaseEvent({ ...baseRow, actionSource: 'system_generated' }).action_source).toBe(
      'website',
    );
    expect(buildPurchaseEvent({ ...baseRow, actionSource: null }).action_source).toBe('website');
  });

  it('omits identifiers that are absent', () => {
    const e = buildPurchaseEvent({
      ...baseRow,
      userId: null,
      city: null,
      fbc: null,
      fbp: null,
    });
    expect(e.user_data).toEqual({});
  });
});

describe('sendEvents', () => {
  const opts = { datasetId: 'DS', token: 'TOK', version: 'v21.0' };

  it('returns ok + events_received on 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ events_received: 1 }) })),
    );
    const r = await sendEvents([buildPurchaseEvent(baseRow)], opts);
    expect(r).toEqual({ ok: true, eventsReceived: 1 });
  });

  it('returns error (no throw) on a Meta error payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'bad' } }) })),
    );
    const r = await sendEvents([], opts);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('bad');
  });

  it('POSTs to the graph /events URL with dataset id + token', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: { body: string }) => ({
      ok: true,
      status: 200,
      json: async () => ({ events_received: 0 }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    await sendEvents([], opts);
    const url = fetchMock.mock.calls[0]![0];
    expect(url).toContain('/v21.0/DS/events');
    expect(url).toContain('access_token=TOK');
  });
});

describe('runCapiUpload gating', () => {
  it('returns skipped:disabled when META_CAPI_ENABLED is false (default) and never calls fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = await runCapiUpload();
    expect(r).toEqual({ skipped: 'disabled' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
