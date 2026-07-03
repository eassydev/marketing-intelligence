import { sql } from 'drizzle-orm';
import { text, integer, boolean, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { marketing, idCol, appCol, appCheck } from './_shared.js';

/** PARKED (Module A — SEO/technical signals). Table created now, no jobs yet. */
export const seoSignal = marketing.table(
  'seo_signal',
  {
    id: idCol(),
    app: appCol(),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull(),
    url: text('url').notNull(),
    rawHtmlOk: boolean('raw_html_ok'), // content present in a NON-JS fetch
    schemaTypes: text('schema_types').array(), // JSON-LD types in raw HTML
    indexable: boolean('indexable'),
    lcpMs: integer('lcp_ms'),
    notes: jsonb('notes'),
  },
  (t) => [
    index('idx_seo_app_url').on(t.app, t.url, t.checkedAt),
    appCheck('seo_app_chk', t.app),
  ],
);
