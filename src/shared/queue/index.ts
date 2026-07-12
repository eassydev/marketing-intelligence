import { Queue, Worker } from 'bullmq';
import { env } from '../../config/env.js';
import { createChildLogger } from '../logger/index.js';
import type { Channel } from '../../marketing/ingest/connector.js';

const log = createChildLogger({ module: 'queue' });

const redisUrl = new URL(env.REDIS_URL);
export const connection = {
  host: redisUrl.hostname,
  port: parseInt(redisUrl.port || '6379', 10),
  password: redisUrl.password ? decodeURIComponent(redisUrl.password) : undefined,
  username: redisUrl.username ? decodeURIComponent(redisUrl.username) : undefined,
};

export const defaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 60_000 },
  removeOnComplete: 200,
  removeOnFail: false,
};

// Every queue name is namespaced by MIL_QUEUE_PREFIX (default 'mil') so multiple
// MIL instances can share a single Redis without colliding on BullMQ keys.
const qn = (suffix: string): string => `${env.MIL_QUEUE_PREFIX}-${suffix}`;

// === Queues ===
export const ingestMetaQueue = new Queue(qn('ingest-meta'), { connection });
export const ingestGoogleQueue = new Queue(qn('ingest-google'), { connection });
export const attributionQueue = new Queue(qn('attribution-resolve'), { connection });
export const alertQueue = new Queue(qn('alerts-evaluate'), { connection });
export const geoMonitorQueue = new Queue(qn('geo-monitor'), { connection });
export const capiMetaQueue = new Queue(qn('capi-meta'), { connection });
export const eventsMaintainQueue = new Queue(qn('events-maintain'), { connection });
export const segmentsRefreshQueue = new Queue(qn('segments-refresh'), { connection });
export const reviewsIngestQueue = new Queue(qn('reviews-ingest'), { connection });

// Segment refreshes are heavier and rebuild whole membership tables; give them a
// longer backoff and only 2 attempts (a bad definition should surface fast).
// removeOnComplete/removeOnFail MUST be true here: refresh jobs use the dedup id
// `refresh-<segmentId>`, and BullMQ silently ignores add() while a job with that id
// exists in ANY state — a retained completed/failed job would starve all future
// refreshes (each tick logs "due" but nothing runs). Failure detail is persisted to
// segment.last_error by refreshSegment(), so BullMQ job retention adds nothing.
const segmentJobOptions = {
  attempts: 2,
  backoff: { type: 'exponential' as const, delay: 120_000 },
  removeOnComplete: true,
  removeOnFail: true,
};

const workers: Worker[] = [];

function ingestWorker(name: string, channel: Channel): Worker {
  const w = new Worker(
    name,
    async (job) => {
      const { runIngest } = await import('../../marketing/jobs/ingest.js');
      log.info({ jobId: job.id, channel }, 'running ingest');
      const result = await runIngest(channel);
      // Chain attribution resolution after each ingest completes.
      await attributionQueue.add('resolve', { after: channel }, defaultJobOptions);
      return result;
    },
    { connection, concurrency: 1 },
  );
  w.on('failed', (job, err) => log.error({ queue: name, jobId: job?.id, err }, 'job failed'));
  w.on('completed', (job) => log.info({ queue: name, jobId: job?.id }, 'job completed'));
  return w;
}

export function startWorkers(): Worker[] {
  workers.push(ingestWorker(qn('ingest-meta'), 'meta'));
  workers.push(ingestWorker(qn('ingest-google'), 'google'));

  const resolveWorker = new Worker(
    qn('attribution-resolve'),
    async (job) => {
      const { runResolver } = await import('../../marketing/attribution/resolve.js');
      log.info({ jobId: job.id }, 'running resolver');
      return runResolver();
    },
    { connection, concurrency: 1 },
  );
  resolveWorker.on('failed', (job, err) =>
    log.error({ queue: qn('attribution-resolve'), jobId: job?.id, err }, 'job failed'),
  );
  workers.push(resolveWorker);

  const alertWorker = new Worker(
    qn('alerts-evaluate'),
    async (job) => {
      const { runAlertEvaluation } = await import('../../marketing/alerts/evaluate.js');
      log.info({ jobId: job.id }, 'running alert evaluation');
      return runAlertEvaluation();
    },
    { connection, concurrency: 1 },
  );
  alertWorker.on('failed', (job, err) =>
    log.error({ queue: qn('alerts-evaluate'), jobId: job?.id, err }, 'job failed'),
  );
  workers.push(alertWorker);

  const geoWorker = new Worker(
    qn('geo-monitor'),
    async (job) => {
      // runGeoMonitor no-ops with a log when buildEngines() is empty (no keys).
      const { runGeoMonitor } = await import('../../marketing/geo/run.js');
      log.info({ jobId: job.id }, 'running geo monitor');
      return runGeoMonitor();
    },
    { connection, concurrency: 1 },
  );
  geoWorker.on('failed', (job, err) =>
    log.error({ queue: qn('geo-monitor'), jobId: job?.id, err }, 'job failed'),
  );
  workers.push(geoWorker);

  const eventsMaintainWorker = new Worker(
    qn('events-maintain'),
    async (job) => {
      const { maintainEventPartitions } = await import(
        '../../marketing/jobs/event-partitions.js'
      );
      log.info({ jobId: job.id }, 'maintaining app_event partitions');
      return maintainEventPartitions();
    },
    { connection, concurrency: 1 },
  );
  eventsMaintainWorker.on('failed', (job, err) =>
    log.error({ queue: qn('events-maintain'), jobId: job?.id, err }, 'job failed'),
  );
  workers.push(eventsMaintainWorker);

  // Segments refresh: two job names on one queue.
  //   refresh-due     → dispatcher: enqueue one refresh-segment per due segment
  //   refresh-segment → recompute a single segment's membership
  const segmentsWorker = new Worker(
    qn('segments-refresh'),
    async (job) => {
      if (job.name === 'refresh-due') {
        const { dueSegmentIds } = await import('../../marketing/segments/refresh.js');
        const ids = await dueSegmentIds();
        log.info({ jobId: job.id, due: ids.length }, 'segments dispatcher');
        // Stagger enqueue so a large batch does not stampede the DB; jobId
        // refresh-<id> dedups a still-queued refresh for the same segment.
        await Promise.all(
          ids.map((id, i) =>
            segmentsRefreshQueue.add(
              'refresh-segment',
              { segmentId: id },
              { ...segmentJobOptions, jobId: `refresh-${id}`, delay: i * 2_000 },
            ),
          ),
        );
        return { dispatched: ids.length };
      }
      const { refreshSegment } = await import('../../marketing/segments/refresh.js');
      const segmentId = (job.data as { segmentId: number }).segmentId;
      log.info({ jobId: job.id, segmentId }, 'refreshing segment');
      return refreshSegment(segmentId);
    },
    { connection, concurrency: 1 },
  );
  segmentsWorker.on('failed', (job, err) =>
    log.error({ queue: qn('segments-refresh'), jobId: job?.id, err }, 'job failed'),
  );
  workers.push(segmentsWorker);

  const reviewsWorker = new Worker(
    qn('reviews-ingest'),
    async (job) => {
      // runReviewsIngest no-ops with a log when no source creds are configured.
      const { runReviewsIngest } = await import('../../marketing/reviews/run.js');
      log.info({ jobId: job.id }, 'running reviews ingest');
      return runReviewsIngest();
    },
    { connection, concurrency: 1 },
  );
  reviewsWorker.on('failed', (job, err) =>
    log.error({ queue: qn('reviews-ingest'), jobId: job?.id, err }, 'job failed'),
  );
  workers.push(reviewsWorker);

  const capiWorker = new Worker(
    qn('capi-meta'),
    async (job) => {
      // runCapiUpload no-ops with a log when META_CAPI_ENABLED is false.
      const { runCapiUpload } = await import('../../marketing/capi/upload-job.js');
      log.info({ jobId: job.id }, 'running Meta CAPI upload');
      return runCapiUpload();
    },
    { connection, concurrency: 1 },
  );
  capiWorker.on('failed', (job, err) =>
    log.error({ queue: qn('capi-meta'), jobId: job?.id, err }, 'job failed'),
  );
  workers.push(capiWorker);

  log.info({ count: workers.length }, 'BullMQ workers started');
  return workers;
}

export async function setupRecurringJobs(): Promise<void> {
  const tz = env.MIL_CRON_TIMEZONE;
  await ingestMetaQueue.upsertJobScheduler(
    'ingest-meta',
    { pattern: '15 */3 * * *', tz },
    { name: 'ingest-meta', data: {}, opts: defaultJobOptions },
  );
  await ingestGoogleQueue.upsertJobScheduler(
    'ingest-google',
    { pattern: '25 */3 * * *', tz },
    { name: 'ingest-google', data: {}, opts: defaultJobOptions },
  );
  await attributionQueue.upsertJobScheduler(
    'resolve-safety',
    { pattern: '45 */3 * * *', tz },
    { name: 'resolve-safety', data: {}, opts: defaultJobOptions },
  );
  await alertQueue.upsertJobScheduler(
    'alerts-evaluate',
    { pattern: '5 * * * *', tz },
    { name: 'alerts-evaluate', data: {}, opts: defaultJobOptions },
  );
  // Weekly (Mon 03:30 IST): AI answers move slowly and every run costs tokens.
  await geoMonitorQueue.upsertJobScheduler(
    'geo-monitor',
    { pattern: '30 3 * * 1', tz },
    { name: 'geo-monitor', data: {}, opts: defaultJobOptions },
  );
  // Monthly (1st, 02:20 IST): pre-create upcoming app_event partitions + drop
  // partitions past MIL_EVENTS_RETENTION_MONTHS.
  await eventsMaintainQueue.upsertJobScheduler(
    'events-maintain',
    { pattern: '20 2 1 * *', tz },
    { name: 'events-maintain', data: {}, opts: defaultJobOptions },
  );
  // Every 15 min (offset from :00 to avoid colliding with the hourly alert job):
  // scan for segments whose refresh interval has elapsed and dispatch refreshes.
  await segmentsRefreshQueue.upsertJobScheduler(
    'segments-refresh-due',
    { pattern: '12,27,42,57 * * * *', tz },
    { name: 'refresh-due', data: {}, opts: segmentJobOptions },
  );
  // Daily (02:45 IST): store/GBP review snapshots. One row per source per day;
  // no-ops with a log when no source creds are configured.
  await reviewsIngestQueue.upsertJobScheduler(
    'reviews-ingest',
    { pattern: '45 2 * * *', tz },
    { name: 'reviews-ingest', data: {}, opts: defaultJobOptions },
  );
  // 20 min after ingest-meta/resolve so attribution has settled. No-ops while
  // META_CAPI_ENABLED is false, so this is safe to schedule now.
  await capiMetaQueue.upsertJobScheduler(
    'capi-meta',
    { pattern: '35 */3 * * *', tz },
    { name: 'capi-meta', data: {}, opts: defaultJobOptions },
  );
  log.info('Recurring jobs scheduled');
}

export async function closeWorkers(): Promise<void> {
  await Promise.all(workers.map((w) => w.close()));
}

export { Queue, Worker };
