import express, { type Express } from 'express';
import type { Db } from './db';

export interface AppDeps {
  db: Db;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Expose db for route modules added in later issues.
  app.locals.db = deps.db;

  app.get('/health', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  return app;
}
