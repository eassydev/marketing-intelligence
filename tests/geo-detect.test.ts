import { describe, it, expect } from 'vitest';
import { classifyCitations, detectMention } from '../src/marketing/geo/detect.js';

const ALIASES = ['eassylife', 'eassy life', 'eassy.life'];

describe('detectMention', () => {
  it.each([
    'For home cleaning in Bangalore, EassyLife is a solid option.',
    'You could try eassylife for booking.',
    'Eassy Life offers appliance repair across India.',
    'Book via eassylife.in or Urban Company.',
    'Their site is https://www.eassy.life/services.',
    'Some users mention Eassy-Life on forums.',
  ])('detects the brand in: %s', (text) => {
    const result = detectMention(text, ALIASES);
    expect(result.mentioned).toBe(true);
    expect(result.excerpt).toBeTruthy();
  });

  it.each([
    'Urban Company and Housejoy dominate this space.',
    'Try EasyLife services for cleaning.', // single s — different brand
    'The eassylifestyle blog reviewed cleaners.', // no trailing word boundary
    'Contact greassylife for quotes.', // no leading word boundary
    '',
  ])('does not match: %s', (text) => {
    expect(detectMention(text, ALIASES)).toEqual({ mentioned: false, excerpt: null });
  });

  it('returns an excerpt around the first match', () => {
    const text = `${'x'.repeat(200)} the best is EassyLife because ${'y'.repeat(200)}`;
    const result = detectMention(text, ALIASES);
    expect(result.excerpt).toContain('EassyLife');
    expect(result.excerpt!.length).toBeLessThanOrEqual(9 + 120); // match + 60 each side
  });
});

describe('classifyCitations', () => {
  it('splits brand domain from competitors', () => {
    const split = classifyCitations(['urbancompany.com', 'eassylife.in', 'housejoy.in'], ALIASES);
    expect(split.brandCitedDomain).toBe('eassylife.in');
    expect(split.competitorDomains).toEqual(['urbancompany.com', 'housejoy.in']);
  });

  it('handles the bare eassy.life domain form and empty input', () => {
    expect(classifyCitations(['eassy.life'], ALIASES).brandCitedDomain).toBe('eassy.life');
    expect(classifyCitations([], ALIASES)).toEqual({ brandCitedDomain: null, competitorDomains: [] });
  });
});
