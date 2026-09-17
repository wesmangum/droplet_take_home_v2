import { randomUUID } from 'node:crypto';
import type { Db } from '../db';
import type { Delivery, DeliveryStatus, EventRow } from '../types';
import { listActiveWebhooks } from './webhooks';

export interface IngestedEvent {
  eventId: string;
  deliveryCount: number;
}

export interface EventWithDeliveries {
  id: string;
  payload: unknown;
  createdAt: string;
  deliveries: Array<{
    id: string;
    webhookId: string;
    status: DeliveryStatus;
    attemptCount: number;
    nextAttemptAt: string;
    lastStatusCode: number | null;
    lastError: string | null;
    updatedAt: string;
  }>;
}

export function ingestEvent(db: Db, payload: unknown): IngestedEvent {
  const eventId = randomUUID();
  const createdAt = new Date().toISOString();
  const payloadJson = JSON.stringify(payload);

  const insertEvent = db.prepare(
    `INSERT INTO events (id, payload, created_at) VALUES (?, ?, ?)`,
  );
  const insertDelivery = db.prepare(
    `INSERT INTO deliveries (
      id, event_id, webhook_id, status, attempt_count, next_attempt_at, last_status_code, last_error, updated_at
    ) VALUES (?, ?, ?, 'pending', 0, ?, NULL, NULL, ?)`,
  );

  // Snapshot active subscribers inside the write txn so concurrent register/ingest
  // cannot fan out against a stale set.
  const run = db.transaction(() => {
    const webhooks = listActiveWebhooks(db);
    insertEvent.run(eventId, payloadJson, createdAt);
    for (const webhook of webhooks) {
      insertDelivery.run(randomUUID(), eventId, webhook.id, createdAt, createdAt);
    }
    return webhooks.length;
  });

  const deliveryCount = run();

  return { eventId, deliveryCount };
}

export function getEventWithDeliveries(db: Db, eventId: string): EventWithDeliveries | null {
  const event = db
    .prepare(`SELECT id, payload, created_at FROM events WHERE id = ?`)
    .get(eventId) as EventRow | undefined;

  if (!event) {
    return null;
  }

  const deliveries = db
    .prepare(
      `SELECT id, event_id, webhook_id, status, attempt_count, next_attempt_at, last_status_code, last_error, updated_at
       FROM deliveries WHERE event_id = ? ORDER BY updated_at ASC, id ASC`,
    )
    .all(eventId) as Delivery[];

  return {
    id: event.id,
    payload: JSON.parse(event.payload) as unknown,
    createdAt: event.created_at,
    deliveries: deliveries.map((d) => ({
      id: d.id,
      webhookId: d.webhook_id,
      status: d.status,
      attemptCount: d.attempt_count,
      nextAttemptAt: d.next_attempt_at,
      lastStatusCode: d.last_status_code,
      lastError: d.last_error,
      updatedAt: d.updated_at,
    })),
  };
}
