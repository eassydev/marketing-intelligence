import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../shared/db/index.js';
import { adEntity } from '../../shared/schema/index.js';
import type { AppKind } from '../../shared/types/app.js';
import { parseEntityName } from '../ingest/normalize.js';
import { inferChannel } from '../ingest/touch-writer.js';

export interface TouchLike {
  utmSource?: string | null;
  utmCampaign?: string | null;
  gclid?: string | null;
  gbraid?: string | null;
  wbraid?: string | null;
  fbclid?: string | null;
  fbc?: string | null;
}

export interface EntityMatch {
  adEntityId: number;
  channel: string;
}

function inferFromUtmSource(src: string | null | undefined): string | null {
  if (!src) return null;
  const s = src.toLowerCase();
  if (['google', 'youtube', 'gdn', 'adwords'].some((x) => s.includes(x))) return 'google';
  if (['facebook', 'meta', 'instagram', 'fb', 'ig'].some((x) => s.includes(x))) return 'meta';
  return null;
}

/**
 * Map a winning touch to an ad_entity, deterministically:
 * 1) utm_campaign == entity name (case-insensitive),
 * 2) else parsed {city}_{category} match for the inferred channel.
 * Returns null when the touch is organic / un-mappable.
 */
export async function mapTouchToEntity(
  app: AppKind,
  touch: TouchLike,
): Promise<EntityMatch | null> {
  const channel = inferChannel(touch) ?? inferFromUtmSource(touch.utmSource);
  if (!channel || !touch.utmCampaign) return null;

  const byName = await db
    .select({ id: adEntity.id })
    .from(adEntity)
    .where(
      and(
        eq(adEntity.app, app),
        eq(adEntity.channel, channel),
        sql`lower(${adEntity.name}) = lower(${touch.utmCampaign})`,
      ),
    )
    .limit(1);
  if (byName[0]) return { adEntityId: byName[0].id, channel };

  const parsed = parseEntityName(touch.utmCampaign);
  if (parsed.parsedOk && parsed.city && parsed.category) {
    const byParsed = await db
      .select({ id: adEntity.id })
      .from(adEntity)
      .where(
        and(
          eq(adEntity.app, app),
          eq(adEntity.channel, channel),
          eq(adEntity.city, parsed.city),
          eq(adEntity.category, parsed.category),
        ),
      )
      .limit(1);
    if (byParsed[0]) return { adEntityId: byParsed[0].id, channel };
  }
  return null;
}
