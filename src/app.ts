import express, { type Express } from 'express';
import type { Db } from './db';
import { eventsRouter } from './routes/events';
import { webhooksRouter } from './routes/webhooks';

export interface AppDeps {
  db: Db;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.locals.db = deps.db;

  app.get('/health', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.use('/webhooks', webhooksRouter());
  app.use('/events', eventsRouter());

  return app;
}
