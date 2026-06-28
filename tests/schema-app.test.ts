import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Structural guard for the multi-tenant rule: every top-level table must carry
 * `app TEXT NOT NULL`, every UNIQUE/PRIMARY KEY must include `app`, and every
 * hot index must lead with `app`. Parses the canonical SQL migration.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const coreSql = readFileSync(join(root, 'drizzle', '0001_core.sql'), 'utf8');
const parkedSql = readFileSync(join(root, 'drizzle', '0002_parked.sql'), 'utf8');
const sql = `${coreSql}\n${parkedSql}`;

const tableBlocks = [...sql.matchAll(/CREATE TABLE marketing\.(\w+) \(([\s\S]*?)\n\);/g)];
const indexLines = [
  ...sql.matchAll(/CREATE INDEX \w+\s+ON marketing\.\w+\s*\(([^)]*)\)/g),
];

describe('multi-tenant schema invariants', () => {
  it('finds every spine + parked table', () => {
    const names = tableBlocks.map((m) => m[1]).sort();
    expect(names).toEqual(
      [
        'ad_entity',
        'ad_performance_daily',
        'alert',
        'attribution_touch',
        'conversion',
        'decision',
        'geo_observation',
        'identity_link',
        'seo_signal',
      ].sort(),
    );
  });

  it.each(tableBlocks.map((m) => [m[1], m[2]] as const))(
    'table %s has app TEXT NOT NULL',
    (_name, body) => {
      expect(body).toMatch(/\bapp\s+TEXT\s+NOT\s+NULL/i);
    },
  );

  it.each(tableBlocks.map((m) => [m[1], m[2]] as const))(
    'table %s includes app in every UNIQUE / PRIMARY KEY',
    (_name, body) => {
      const keyClauses = [
        ...body.matchAll(/(?:UNIQUE|PRIMARY KEY)\s*\(([^)]*)\)/g),
      ].map((m) => m[1]);
      for (const cols of keyClauses) {
        expect(cols.split(',').map((c) => c.trim())).toContain('app');
      }
    },
  );

  it('every hot index leads with app', () => {
    expect(indexLines.length).toBeGreaterThan(0);
    for (const [, cols] of indexLines) {
      const first = cols.split(',')[0]!.trim();
      expect(first).toBe('app');
    }
  });
});
