import { sql } from 'drizzle-orm';
import { db } from '../../shared/db/index.js';
import { adEntity, adPerformanceDaily } from '../../shared/schema/index.js';
import type { AppKind } from '../../shared/types/app.js';
import type { NormalizedEntity, NormalizedPerfRow } from './connector.js';
import { parseEntityName } from './normalize.js';

/** key = `${channel}:${externalId}` → ad_entity.id */
export type EntityIdMap = Map<string, number>;

export async function upsertEntities(
  app: AppKind,
  rows: NormalizedEntity[],
): Promise<EntityIdMap> {
  const map: EntityIdMap = new Map();
  if (rows.length === 0) return map;

  const values = rows.map((r) => {
    const parsed = parseEntityName(r.name);
    return {
      app,
      channel: r.channel,
      level: r.level,
      externalId: r.externalId,
      parentExternalId: r.parentExternalId ?? null,
      name: r.name ?? null,
      city: parsed.city ?? null,
      category: parsed.category ?? null,
      objective: parsed.objective ?? null,
      status: r.status ?? null,
      currentDailyBudgetInr: r.dailyBudgetInr != null ? String(r.dailyBudgetInr) : null,
      currency: r.currency ?? null,
    };
  });

  const returned = await db
    .insert(adEntity)
    .values(values)
    .onConflictDoUpdate({
      target: [adEntity.app, adEntity.channel, adEntity.level, adEntity.externalId],
      set: {
        name: sql`excluded.name`,
        city: sql`excluded.city`,
        category: sql`excluded.category`,
        objective: sql`excluded.objective`,
        status: sql`excluded.status`,
        currentDailyBudgetInr: sql`excluded.current_daily_budget_inr`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: adEntity.id, channel: adEntity.channel, externalId: adEntity.externalId });

  for (const row of returned) map.set(`${row.channel}:${row.externalId}`, row.id);
  return map;
}

export async function upsertPerformance(
  app: AppKind,
  rows: NormalizedPerfRow[],
  idMap: EntityIdMap,
): Promise<number> {
  const values = [];
  for (const r of rows) {
    const adEntityId = idMap.get(`${r.channel}:${r.externalId}`);
    if (adEntityId == null) continue; // entity not in this batch — skip, log upstream
    values.push({
      app,
      adEntityId,
      statDate: r.statDate,
      channel: r.channel,
      spendInr: String(r.spendInr),
      impressions: r.impressions,
      clicks: r.clicks,
      conversions: String(r.conversions),
      convValueInr: String(r.convValueInr),
    });
  }
  if (values.length === 0) return 0;

  await db
    .insert(adPerformanceDaily)
    .values(values)
    .onConflictDoUpdate({
      target: [
        adPerformanceDaily.app,
        adPerformanceDaily.adEntityId,
        adPerformanceDaily.statDate,
      ],
      set: {
        spendInr: sql`excluded.spend_inr`,
        impressions: sql`excluded.impressions`,
        clicks: sql`excluded.clicks`,
        conversions: sql`excluded.conversions`,
        convValueInr: sql`excluded.conv_value_inr`,
        ingestedAt: sql`now()`,
      },
    });
  return values.length;
}
