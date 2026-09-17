import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { Db } from './db';
import { eventsRouter } from './routes/events';
import { statusRouter } from './routes/status';
import { webhooksRouter } from './routes/webhooks';
import { logger, type Logger } from './services/logger';

export interface AppDeps {
  db: Db;
  logger?: Logger;
}

function requestLogging(log: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const started = Date.now();
    res.on('finish', () => {
      log.info('http request', {
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        durationMs: Date.now() - started,
      });
    });
    next();
  };
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  const log = deps.logger ?? logger;

  app.use(express.json({ limit: '1mb' }));
  app.use(requestLogging(log));

  app.locals.db = deps.db;

  app.get('/health', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.use('/webhooks', webhooksRouter());
  app.use('/events', eventsRouter());
  app.use('/status', statusRouter());

  return app;
}
