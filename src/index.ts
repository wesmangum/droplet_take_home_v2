import { createApp } from './app';
import { defaultDbPath, openDb } from './db';
import { logger } from './services/logger';

const port = Number(process.env.PORT ?? 3000);
const db = openDb(defaultDbPath());
const app = createApp({ db });

app.listen(port, () => {
  logger.info('server listening', { port, dbPath: defaultDbPath() });
});
