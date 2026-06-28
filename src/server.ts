import { buildApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './shared/logger/index.js';
import { redis } from './shared/redis/index.js';
import { pool } from './shared/db/index.js';
import { startWorkers, setupRecurringJobs, closeWorkers } from './shared/queue/index.js';

async function start(): Promise<void> {
  const app = await buildApp();

  const shutdown = (signal: NodeJS.Signals) => async () => {
    app.log.info({ signal }, 'Shutting down gracefully');
    await app.close();
    await closeWorkers();
    await redis.quit();
    await pool.end();
    process.exit(0);
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as NodeJS.Signals[]) {
    process.on(signal, shutdown(signal));
  }

  startWorkers();
  await setupRecurringJobs();

  await app.listen({ host: env.HOST, port: env.PORT });
  app.log.info(`MIL server running at http://${env.HOST}:${env.PORT}`);
}

start().catch((err) => {
  logger.error({ err }, 'Failed to start MIL server');
  process.exit(1);
});
