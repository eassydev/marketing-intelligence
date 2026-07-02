import { env } from '../../config/env.js';

/**
 * One buyer question asked of every engine. `key` is stored as
 * geo_observation.prompt_key and is the stable trend/aggregation dimension:
 *   templated → `{template}|{category}|{city}`  (parsed back out in SQL)
 *   brand probes → `brand|{probe-id}`           (no city/category parts)
 * Keep the `|` structure stable — the summary queries split on it.
 */
export interface GeoQuestion {
  key: string;
  text: string;
  city: string | null;
  category: string | null;
}

export interface QuestionConfig {
  cities: string[];
  categories: string[];
  maxQuestions: number;
}

const BRAND_PROBES: GeoQuestion[] = [
  { key: 'brand|what-is', text: 'what is EassyLife?', city: null, category: null },
  {
    key: 'brand|legit-check',
    text: 'is eassy.life a legit home services company in India?',
    city: null,
    category: null,
  },
];

const TEMPLATES = [
  { id: 'best', render: (category: string, city: string) => `best ${category} services in ${city}` },
  {
    id: 'book',
    render: (category: string, city: string) => `how do I book ${category} online in ${city}`,
  },
] as const;

/**
 * Deterministic question set: the 2 brand probes first (never truncated away),
 * then template × category × city in input order, truncated to the hard cost
 * cap. No randomness — identical config produces identical questions, so
 * week-over-week trends compare like with like.
 */
export function buildQuestions(config: QuestionConfig): GeoQuestion[] {
  const questions: GeoQuestion[] = [...BRAND_PROBES];
  for (const template of TEMPLATES) {
    for (const category of config.categories) {
      for (const city of config.cities) {
        questions.push({
          key: `${template.id}|${category}|${city}`,
          text: template.render(category, city),
          city,
          category,
        });
      }
    }
  }
  return questions.slice(0, config.maxQuestions);
}

export function buildQuestionsFromEnv(): GeoQuestion[] {
  return buildQuestions({
    cities: env.MIL_GEO_CITIES,
    categories: env.MIL_GEO_CATEGORIES,
    maxQuestions: env.MIL_GEO_MAX_QUESTIONS,
  });
}
