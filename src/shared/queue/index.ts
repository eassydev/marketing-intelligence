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
  log.info('Recurring jobs scheduled');
}

export async function closeWorkers(): Promise<void> {
  await Promise.all(workers.map((w) => w.close()));
}

export { Queue, Worker };
