import { sql } from 'drizzle-orm';
import { text, integer, boolean, jsonb, timestamp, index, check } from 'drizzle-orm/pg-core';
import { marketing, idCol, appCol } from './_shared.js';

/** PARKED (Module A — GEO/AI-presence monitor). Table created now, no jobs yet. */
export const geoObservation = marketing.table(
  'geo_observation',
  {
    id: idCol(),
    app: appCol(),
    runAt: timestamp('run_at', { withTimezone: true }).notNull(),
    engine: text('engine').notNull(), // chatgpt | claude | perplexity | google_aio
    promptKey: text('prompt_key').notNull(),
    prompt: text('prompt').notNull(),
    brandMentioned: boolean('brand_mentioned'),
    position: integer('position'),
    citedUrl: text('cited_url'),
    competitors: jsonb('competitors'),
    rawResponse: text('raw_response'),
  },
  (t) => [
    index('idx_geo_app_prompt').on(t.app, t.promptKey, t.runAt),
    check('geo_app_chk', sql`${t.app} in ('services','society')`),
  ],
);
