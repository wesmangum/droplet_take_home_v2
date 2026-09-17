import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Db } from '../db';
import { getEventWithDeliveries, ingestEvent } from '../services/events';

const eventIdSchema = z.string().uuid();

function getDb(req: Request): Db {
  return req.app.locals.db as Db;
}

/** Accept `{ payload }` or treat the whole JSON object as the event payload. */
export function extractEventPayload(body: unknown): unknown | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return undefined;
  }

  const record = body as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, 'payload')) {
    return record.payload;
  }

  return body;
}

export function eventsRouter(): Router {
  const router = Router();

  router.post('/', (req: Request, res: Response) => {
    const payload = extractEventPayload(req.body);
    if (payload === undefined) {
      res.status(400).json({
        error: 'invalid_request',
        message: 'Request body must be a JSON object (optionally with a payload field)',
      });
      return;
    }

    const result = ingestEvent(getDb(req), payload);
    res.status(202).json({
      eventId: result.eventId,
      deliveryCount: result.deliveryCount,
    });
  });

  router.get('/:id', (req: Request, res: Response) => {
    const parsedId = eventIdSchema.safeParse(req.params.id);
    if (!parsedId.success) {
      res.status(400).json({ error: 'invalid_event_id' });
      return;
    }

    const event = getEventWithDeliveries(getDb(req), parsedId.data);
    if (!event) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    res.status(200).json(event);
  });

  return router;
}
