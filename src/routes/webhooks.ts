import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Db } from '../db';
import { createWebhook, listWebhooks } from '../services/webhooks';

const createWebhookSchema = z.object({
  url: z
    .string()
    .url()
    .refine((value) => {
      try {
        const protocol = new URL(value).protocol;
        return protocol === 'http:' || protocol === 'https:';
      } catch {
        return false;
      }
    }, { message: 'url must use http or https' }),
});

function getDb(req: Request): Db {
  return req.app.locals.db as Db;
}

export function webhooksRouter(): Router {
  const router = Router();

  router.post('/', (req: Request, res: Response) => {
    const parsed = createWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid_request',
        details: parsed.error.flatten(),
      });
      return;
    }

    const webhook = createWebhook(getDb(req), parsed.data.url);
    res.status(201).json(webhook);
  });

  router.get('/', (req: Request, res: Response) => {
    res.status(200).json({ webhooks: listWebhooks(getDb(req)) });
  });

  return router;
}
