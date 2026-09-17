import { createApp } from './app';
import { defaultDbPath, openDb } from './db';
import { startDeliveryWorker } from './services/deliveryWorker';
import { logger } from './services/logger';

const port = Number(process.env.PORT ?? 3000);
const dbPath = defaultDbPath();
const db = openDb(dbPath);
const app = createApp({ db });
const worker = startDeliveryWorker(db);

const server = app.listen(port, () => {
  logger.info('server listening', { port, dbPath });
});

function shutdown(signal: string): void {
  logger.info('shutting down', { signal });
  void (async () => {
    await worker.stop();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    db.close();
    process.exit(0);
  })().catch((err) => {
    logger.error('shutdown failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
