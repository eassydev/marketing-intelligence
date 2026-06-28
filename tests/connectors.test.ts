import { describe, it, expect, vi, afterEach } from 'vitest';
import { MetaConnector } from '../src/marketing/ingest/meta-connector.js';
import { GoogleConnector } from '../src/marketing/ingest/google-connector.js';

const range = { since: '2026-06-01', until: '2026-06-01' };
const jsonRes = (obj: unknown) => ({
  ok: true,
  status: 200,
  json: async () => obj,
  text: async () => JSON.stringify(obj),
});

afterEach(() => vi.unstubAllGlobals());

describe('MetaConnector', () => {
  it('normalizes entities and purchase performance', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('fields=currency')) return jsonRes({ currency: 'INR' });
        if (url.includes('/campaigns'))
          return jsonRes({
            data: [{ id: 'c1', name: 'mumbai_homecleaning_purchase', effective_status: 'ACTIVE', daily_budget: '50000' }],
          });
        if (url.includes('/adsets')) return jsonRes({ data: [{ id: 's1', name: 'set1', campaign_id: 'c1' }] });
        if (url.includes('/ads')) return jsonRes({ data: [{ id: 'a1', name: 'ad1', adset_id: 's1' }] });
        if (url.includes('/insights'))
          return jsonRes({
            data: [
              {
                ad_id: 'a1',
                date_start: '2026-06-01',
                spend: '100.5',
                impressions: '1000',
                clicks: '20',
                actions: [{ action_type: 'purchase', value: '2' }, { action_type: 'link_click', value: '9' }],
                action_values: [{ action_type: 'purchase', value: '500' }],
              },
            ],
          });
        return jsonRes({ data: [] });
      }),
    );

    const c = new MetaConnector({ accessToken: 't', adAccountId: '123', graphVersion: 'v21.0' });
    const entities = await c.fetchEntities('services', range);
    const campaign = entities.find((e) => e.externalId === 'c1');
    expect(campaign).toMatchObject({ level: 'campaign', dailyBudgetInr: 500 });
    expect(entities.find((e) => e.externalId === 's1')?.parentExternalId).toBe('c1');

    const perf = await c.fetchPerformance('services', range);
    expect(perf[0]).toMatchObject({
      externalId: 'a1',
      statDate: '2026-06-01',
      spendInr: 100.5,
      conversions: 2, // only purchase counted, not link_click
      convValueInr: 500,
    });
  });

  it('throws on non-INR account currency', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ currency: 'USD' })));
    const c = new MetaConnector({ accessToken: 't', adAccountId: '1', graphVersion: 'v21.0' });
    await expect(c.fetchEntities('services', range)).rejects.toThrow(/INR/);
  });
});

describe('GoogleConnector', () => {
  it('exchanges the refresh token and normalizes micros to INR', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('oauth2.googleapis.com/token')) return jsonRes({ access_token: 'at' });
      if (url.includes('searchStream'))
        return jsonRes([
          {
            results: [
              {
                campaign: { id: 'c1', name: 'mumbai_homecleaning_purchase', status: 'ENABLED' },
                adGroup: { id: 'g1', name: 'grp' },
                metrics: { costMicros: '2000000', impressions: '500', clicks: '10', conversions: 3, conversionsValue: 900 },
                segments: { date: '2026-06-01' },
              },
            ],
          },
        ]);
      return jsonRes([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const c = new GoogleConnector({
      developerToken: 'd',
      clientId: 'i',
      clientSecret: 's',
      refreshToken: 'r',
      loginCustomerId: '1',
      customerId: '2',
      apiVersion: 'v18',
    });

    const entities = await c.fetchEntities('services', range);
    expect(entities.map((e) => e.level).sort()).toEqual(['adset', 'campaign']);

    const perf = await c.fetchPerformance('services', range);
    expect(perf[0]).toMatchObject({
      externalId: 'c1',
      spendInr: 2,
      conversions: 3,
      convValueInr: 900,
    });
  });
});
