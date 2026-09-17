import { Router, type Request, type Response } from 'express';
import type { Db } from '../db';
import { getStatus } from '../services/status';

function getDb(req: Request): Db {
  return req.app.locals.db as Db;
}

export function statusRouter(): Router {
  const router = Router();

  router.get('/', (req: Request, res: Response) => {
    res.status(200).json(getStatus(getDb(req)));
  });

  return router;
}
