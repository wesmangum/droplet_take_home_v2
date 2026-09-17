import type { Db } from '../db';
import type { DeliveryStatus } from '../types';

const DELIVERY_STATUSES: DeliveryStatus[] = ['pending', 'retrying', 'delivered', 'dead'];

export interface DeliveryCounts {
  pending: number;
  retrying: number;
  delivered: number;
  dead: number;
}

export interface RecentFailure {
  id: string;
  eventId: string;
  webhookId: string;
  status: 'retrying' | 'dead';
  attemptCount: number;
  lastStatusCode: number | null;
  lastError: string | null;
  updatedAt: string;
}

export interface StatusSnapshot {
  counts: DeliveryCounts;
  /** Deliveries still owed work: pending + retrying. */
  queueDepth: number;
  webhooks: {
    total: number;
    active: number;
  };
  events: {
    total: number;
  };
  recentFailures: RecentFailure[];
}

const DEFAULT_RECENT_FAILURE_LIMIT = 20;

export function getStatus(
  db: Db,
  opts: { recentFailureLimit?: number } = {},
): StatusSnapshot {
  const recentFailureLimit = opts.recentFailureLimit ?? DEFAULT_RECENT_FAILURE_LIMIT;

  const countRows = db
    .prepare(
      `SELECT status, COUNT(*) AS count
       FROM deliveries
       GROUP BY status`,
    )
    .all() as Array<{ status: DeliveryStatus; count: number }>;

  const counts: DeliveryCounts = {
    pending: 0,
    retrying: 0,
    delivered: 0,
    dead: 0,
  };

  for (const row of countRows) {
    if (DELIVERY_STATUSES.includes(row.status)) {
      counts[row.status] = Number(row.count);
    }
  }

  const webhookRow = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END), 0) AS active
       FROM webhooks`,
    )
    .get() as { total: number; active: number };

  const eventRow = db
    .prepare(`SELECT COUNT(*) AS total FROM events`)
    .get() as { total: number };

  const failureRows = db
    .prepare(
      `SELECT
         id,
         event_id,
         webhook_id,
         status,
         attempt_count,
         last_status_code,
         last_error,
         updated_at
       FROM deliveries
       WHERE status IN ('retrying', 'dead')
         AND last_error IS NOT NULL
       ORDER BY updated_at DESC, id DESC
       LIMIT ?`,
    )
    .all(recentFailureLimit) as Array<{
    id: string;
    event_id: string;
    webhook_id: string;
    status: 'retrying' | 'dead';
    attempt_count: number;
    last_status_code: number | null;
    last_error: string | null;
    updated_at: string;
  }>;

  return {
    counts,
    queueDepth: counts.pending + counts.retrying,
    webhooks: {
      total: Number(webhookRow.total),
      active: Number(webhookRow.active),
    },
    events: {
      total: Number(eventRow.total),
    },
    recentFailures: failureRows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      webhookId: row.webhook_id,
      status: row.status,
      attemptCount: row.attempt_count,
      lastStatusCode: row.last_status_code,
      lastError: row.last_error,
      updatedAt: row.updated_at,
    })),
  };
}
