import { describe, it, expect, vi, afterEach } from 'vitest';
import { PerplexityEngine } from '../src/marketing/geo/engines/perplexity.js';
import { extractDomains, toDomain } from '../src/marketing/geo/engines/http.js';

const jsonRes = (obj: unknown, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => obj,
  text: async () => JSON.stringify(obj),
});

const answer = {
  choices: [
    {
      message: {
        content:
          'Top options in Bangalore include EassyLife (https://eassylife.in/home-cleaning) and Urban Company.',
      },
    },
  ],
  citations: ['https://www.urbancompany.com/bangalore', 'https://eassylife.in/home-cleaning'],
};

afterEach(() => vi.unstubAllGlobals());

describe('PerplexityEngine', () => {
  it('parses the answer text and unions native citations with inline URLs', async () => {
    const fetchMock = vi.fn(async () => jsonRes(answer));
    vi.stubGlobal('fetch', fetchMock);

    const engine = new PerplexityEngine({ apiKey: 'pk', model: 'sonar' });
    const res = await engine.ask('best home cleaning services in bangalore');

    expect(res.text).toContain('EassyLife');
    expect(res.citedDomains.sort()).toEqual(['eassylife.in', 'urbancompany.com']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.perplexity.ai/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer pk');
    expect(JSON.parse(init.body as string).model).toBe('sonar');
  });

  it('retries once on 429 then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ error: 'rate limited' }, 429))
      .mockResolvedValueOnce(jsonRes(answer));
    vi.stubGlobal('fetch', fetchMock);

    const engine = new PerplexityEngine({ apiKey: 'pk', model: 'sonar' });
    const res = await engine.ask('q');
    expect(res.citedDomains).toContain('eassylife.in');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws (no second retry) when the failure persists', async () => {
    const fetchMock = vi.fn(async () => jsonRes({ error: 'down' }, 500));
    vi.stubGlobal('fetch', fetchMock);

    const engine = new PerplexityEngine({ apiKey: 'pk', model: 'sonar' });
    await expect(engine.ask('q')).rejects.toThrow('perplexity API 500');
    expect(fetchMock).toHaveBeenCalledTimes(2); // original + exactly one retry
  });

  it('throws immediately on a non-retryable 4xx', async () => {
    const fetchMock = vi.fn(async () => jsonRes({ error: 'bad key' }, 401));
    vi.stubGlobal('fetch', fetchMock);

    const engine = new PerplexityEngine({ apiKey: 'pk', model: 'sonar' });
    await expect(engine.ask('q')).rejects.toThrow('perplexity API 401');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('domain extraction helpers', () => {
  it('extracts deduped hostnames from inline URLs, stripping www and punctuation', () => {
    const text =
      'See https://www.eassylife.in/pricing, https://eassylife.in/faq and (https://housejoy.in).';
    expect(extractDomains(text).sort()).toEqual(['eassylife.in', 'housejoy.in']);
  });

  it('normalizes bare domains and rejects garbage', () => {
    expect(toDomain('eassy.life')).toBe('eassy.life');
    expect(toDomain('https://www.urbancompany.com/x')).toBe('urbancompany.com');
    expect(toDomain('not a url')).toBeNull();
  });
});
