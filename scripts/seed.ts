/**
 * Dev seed. Phase 0 seeds one Meta + one Google ad_entity for the `services`
 * tenant so the serving API (Phase 1) has something to render. Safe to re-run:
 * inserts are upserts on the natural key.
 */
import { db } from '../src/shared/db/index.js';
import { adEntity } from '../src/shared/schema/index.js';

async function seed(): Promise<void> {
  await db
    .insert(adEntity)
    .values([
      {
        app: 'services',
        channel: 'meta',
        level: 'campaign',
        externalId: 'seed_meta_camp_1',
        name: 'mumbai_home_cleaning_purchase',
        city: 'mumbai',
        category: 'home_cleaning',
        objective: 'purchase',
        currency: 'INR',
      },
      {
        app: 'services',
        channel: 'google',
        level: 'campaign',
        externalId: 'seed_google_camp_1',
        name: 'mumbai_bathroom_cleaning_purchase',
        city: 'mumbai',
        category: 'bathroom_cleaning',
        objective: 'purchase',
        currency: 'INR',
      },
    ])
    .onConflictDoNothing();
  console.log('seed complete');
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
