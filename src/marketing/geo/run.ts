import { env } from '../../config/env.js';
import { db } from '../../shared/db/index.js';
import { geoObservation } from '../../shared/schema/index.js';
import { createChildLogger } from '../../shared/logger/index.js';
import type { GeoEngine } from './engines/types.js';
import { buildEngines } from './factory.js';
import { buildQuestionsFromEnv, type GeoQuestion } from './questions.js';
import { classifyCitations, detectMention } from './detect.js';

const log = createChildLogger({ module: 'geo-run' });

/** Bound raw_response row size; answers are max_tokens-capped anyway. */
const RAW_RESPONSE_MAX_CHARS = 10_000;

/** Max engines queried at once. Questions run sequentially WITHIN an engine, so
 * this is also the max requests in flight per provider (1) and overall (3). */
const ENGINE_CONCURRENCY = 3;

export interface GeoRunResult {
  engines: number;
  questions: number;
  observations: number;
  mentions: number;
}

interface EngineTally {
  observations: number;
  mentions: number;
}

/**
 * Module A entrypoint: ask every configured engine every buyer question, detect
 * whether EassyLife is mentioned, and persist one geo_observation row each.
 * A single engine outage skips that question (logged), never the whole run.
 */
export async function runGeoMonitor(): Promise<GeoRunResult> {
  const engines = buildEngines();
  const questions = buildQuestionsFromEnv();
  if (engines.length === 0) {
    log.warn('No engine API keys configured — skipping geo monitor run');
    return { engines: 0, questions: questions.length, observations: 0, mentions: 0 };
  }

  const runAt = new Date();
  // Shared abort flag: a persistence failure in any engine lane trips this so the
  // remaining lanes stop spending LLM budget and the run rejects (→ BullMQ retries).
  const state = { aborted: false };
  const tallies = await mapWithConcurrency(engines, ENGINE_CONCURRENCY, (engine) =>
    runEngine(engine, questions, runAt, state),
  );

  const result = tallies.reduce<GeoRunResult>(
    (acc, t) => ({
      ...acc,
      observations: acc.observations + t.observations,
      mentions: acc.mentions + t.mentions,
    }),
    { engines: engines.length, questions: questions.length, observations: 0, mentions: 0 },
  );
  log.info(result, 'geo monitor run complete');
  return result;
}

async function runEngine(
  engine: GeoEngine,
  questions: GeoQuestion[],
  runAt: Date,
  state: { aborted: boolean },
): Promise<EngineTally> {
  let observations = 0;
  let mentions = 0;
  for (const question of questions) {
    if (state.aborted) break; // a persistence failure elsewhere — stop spending
    let answer;
    try {
      answer = await engine.ask(question.text);
    } catch (err) {
      // Engine outage / rate-limit for THIS question only — skip it, keep going.
      log.error(
        { engine: engine.engine, promptKey: question.key, err: (err as Error).message },
        'geo engine question failed — continuing with next',
      );
      continue;
    }
    const detection = detectMention(answer.text, env.MIL_BRAND_ALIASES);
    const citations = classifyCitations(answer.citedDomains, env.MIL_BRAND_ALIASES);
    try {
      await db.insert(geoObservation).values({
        app: env.MIL_DEFAULT_APP,
        runAt,
        engine: engine.engine,
        promptKey: question.key,
        prompt: question.text,
        brandMentioned: detection.mentioned,
        position: null,
        citedUrl: citations.brandCitedDomain,
        competitors: citations.competitorDomains,
        rawResponse: answer.text.slice(0, RAW_RESPONSE_MAX_CHARS),
      });
    } catch (dbErr) {
      // Persistence failure is NOT swallowed: abort the run so the BullMQ job fails
      // and retries (attempts:3) instead of silently writing zero rows for the week.
      state.aborted = true;
      throw dbErr;
    }
    observations += 1;
    if (detection.mentioned) mentions += 1;
  }
  log.info({ engine: engine.engine, observations, mentions }, 'engine pass complete');
  return { observations, mentions };
}

/** Small worker pool: run `fn` over `items` with at most `limit` in flight. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(lanes);
  return results;
}
