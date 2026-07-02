import { describe, it, expect } from 'vitest';
import { buildQuestions } from '../src/marketing/geo/questions.js';

const config = {
  cities: ['bangalore', 'mumbai', 'delhi', 'pune', 'hyderabad'],
  categories: ['home cleaning', 'plumbing', 'electrician', 'appliance repair', 'pest control'],
  maxQuestions: 40,
};

describe('buildQuestions', () => {
  it('truncates the full matrix to the hard cost cap', () => {
    // 2 probes + 2 templates × 5 categories × 5 cities = 52 → capped at 40.
    const questions = buildQuestions(config);
    expect(questions).toHaveLength(40);
  });

  it('keeps the 2 brand probes first so the cap never drops them', () => {
    const questions = buildQuestions({ ...config, maxQuestions: 3 });
    expect(questions.map((q) => q.key)).toEqual(['brand|what-is', 'brand|legit-check', 'best|home cleaning|bangalore']);
    expect(questions[0]!.text).toBe('what is EassyLife?');
    expect(questions[0]!.city).toBeNull();
    expect(questions[0]!.category).toBeNull();
  });

  it('renders both templates with city/category and structured keys', () => {
    const questions = buildQuestions({ cities: ['pune'], categories: ['plumbing'], maxQuestions: 40 });
    expect(questions).toHaveLength(4); // 2 probes + best + book
    expect(questions[2]).toEqual({
      key: 'best|plumbing|pune',
      text: 'best plumbing services in pune',
      city: 'pune',
      category: 'plumbing',
    });
    expect(questions[3]).toEqual({
      key: 'book|plumbing|pune',
      text: 'how do I book plumbing online in pune',
      city: 'pune',
      category: 'plumbing',
    });
  });

  it('is deterministic and keys are unique', () => {
    const a = buildQuestions(config);
    const b = buildQuestions(config);
    expect(a).toEqual(b);
    expect(new Set(a.map((q) => q.key)).size).toBe(a.length);
  });
});
