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

// === Queues ===
export const ingestMetaQueue = new Queue('mil-ingest-meta', { connection });
export const ingestGoogleQueue = new Queue('mil-ingest-google', { connection });
export const attributionQueue = new Queue('mil-attribution-resolve', { connection });
export const alertQueue = new Queue('mil-alerts-evaluate', { connection });

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
  workers.push(ingestWorker('mil-ingest-meta', 'meta'));
  workers.push(ingestWorker('mil-ingest-google', 'google'));

  const resolveWorker = new Worker(
    'mil-attribution-resolve',
    async (job) => {
      const { runResolver } = await import('../../marketing/attribution/resolve.js');
      log.info({ jobId: job.id }, 'running resolver');
      return runResolver();
    },
    { connection, concurrency: 1 },
  );
  resolveWorker.on('failed', (job, err) =>
    log.error({ queue: 'mil-attribution-resolve', jobId: job?.id, err }, 'job failed'),
  );
  workers.push(resolveWorker);

  const alertWorker = new Worker(
    'mil-alerts-evaluate',
    async (job) => {
      const { runAlertEvaluation } = await import('../../marketing/alerts/evaluate.js');
      log.info({ jobId: job.id }, 'running alert evaluation');
      return runAlertEvaluation();
    },
    { connection, concurrency: 1 },
  );
  alertWorker.on('failed', (job, err) =>
    log.error({ queue: 'mil-alerts-evaluate', jobId: job?.id, err }, 'job failed'),
  );
  workers.push(alertWorker);

  log.info({ count: workers.length }, 'BullMQ workers started');
  return workers;
}

export async function setupRecurringJobs(): Promise<void> {
  const tz = 'Asia/Kolkata';
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
  log.info('Recurring jobs scheduled');
}

export async function closeWorkers(): Promise<void> {
  await Promise.all(workers.map((w) => w.close()));
}

export { Queue, Worker };
