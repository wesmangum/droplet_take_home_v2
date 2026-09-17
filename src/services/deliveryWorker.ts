import type { Db } from '../db';
import type { DeliveryStatus } from '../types';
import { signBody } from './hmac';
import { logger } from './logger';

export const MAX_ATTEMPTS = 5;
export const HTTP_TIMEOUT_MS = 5_000;
export const POLL_INTERVAL_MS = 500;
export const CLAIM_LEASE_MS = 60_000;
export const BASE_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 60_000;

export interface DeliveryWorkerOptions {
  pollIntervalMs?: number;
  httpTimeoutMs?: number;
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Deterministic jitter [0, 1) for tests; default Math.random */
  random?: () => number;
}

export interface ClaimedDelivery {
  id: string;
  event_id: string;
  webhook_id: string;
  status: DeliveryStatus;
  attempt_count: number;
  url: string;
  secret: string;
  payload: string;
  event_created_at: string;
}

export function isRetryableStatus(statusCode: number): boolean {
  return statusCode === 429 || statusCode >= 500;
}

export function isPermanentFailureStatus(statusCode: number): boolean {
  return statusCode >= 400 && statusCode < 500 && statusCode !== 429;
}

/** Exponential backoff with full jitter: random * min(cap, base * 2^(attempt-1)) */
export function computeBackoffMs(
  attemptCount: number,
  random: () => number = Math.random,
  baseMs = BASE_BACKOFF_MS,
  maxMs = MAX_BACKOFF_MS,
): number {
  const exp = Math.max(0, attemptCount - 1);
  const ceiling = Math.min(maxMs, baseMs * 2 ** exp);
  return Math.floor(random() * ceiling);
}

export function buildDeliveryBody(eventId: string, createdAt: string, payloadJson: string): string {
  const data = JSON.parse(payloadJson) as unknown;
  return JSON.stringify({
    id: eventId,
    createdAt,
    data,
  });
}

type DueRow = ClaimedDelivery;

export function claimDueDeliveries(db: Db, now: Date, limit = 10): ClaimedDelivery[] {
  const nowIso = now.toISOString();
  const leaseUntil = new Date(now.getTime() + CLAIM_LEASE_MS).toISOString();

  const claim = db.transaction(() => {
    const due = db
      .prepare(
        `SELECT
           d.id,
           d.event_id,
           d.webhook_id,
           d.status,
           d.attempt_count,
           w.url,
           w.secret,
           e.payload,
           e.created_at AS event_created_at
         FROM deliveries d
         JOIN webhooks w ON w.id = d.webhook_id
         JOIN events e ON e.id = d.event_id
         WHERE d.status IN ('pending', 'retrying')
           AND d.next_attempt_at <= ?
         ORDER BY d.next_attempt_at ASC
         LIMIT ?`,
      )
      .all(nowIso, limit) as DueRow[];

    const bump = db.prepare(
      `UPDATE deliveries SET next_attempt_at = ?, updated_at = ? WHERE id = ?`,
    );

    for (const row of due) {
      bump.run(leaseUntil, nowIso, row.id);
    }

    return due;
  });

  return claim();
}

export function markDelivered(db: Db, deliveryId: string, statusCode: number, now: Date): void {
  const nowIso = now.toISOString();
  db.prepare(
    `UPDATE deliveries
     SET status = 'delivered',
         attempt_count = attempt_count + 1,
         last_status_code = ?,
         last_error = NULL,
         updated_at = ?,
         next_attempt_at = ?
     WHERE id = ?`,
  ).run(statusCode, nowIso, nowIso, deliveryId);
}

export function markFailure(
  db: Db,
  deliveryId: string,
  opts: {
    attemptCountAfter: number;
    statusCode: number | null;
    error: string;
    retryable: boolean;
    now: Date;
    random?: () => number;
    maxAttempts?: number;
  },
): DeliveryStatus {
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const nowIso = opts.now.toISOString();
  const shouldRetry = opts.retryable && opts.attemptCountAfter < maxAttempts;
  const status: DeliveryStatus = shouldRetry ? 'retrying' : 'dead';
  const nextAttemptAt = shouldRetry
    ? new Date(
        opts.now.getTime() +
          computeBackoffMs(opts.attemptCountAfter, opts.random ?? Math.random),
      ).toISOString()
    : nowIso;

  db.prepare(
    `UPDATE deliveries
     SET status = ?,
         attempt_count = ?,
         last_status_code = ?,
         last_error = ?,
         next_attempt_at = ?,
         updated_at = ?
     WHERE id = ?`,
  ).run(
    status,
    opts.attemptCountAfter,
    opts.statusCode,
    opts.error,
    nextAttemptAt,
    nowIso,
    deliveryId,
  );

  return status;
}

export async function attemptDelivery(
  delivery: ClaimedDelivery,
  opts: {
    fetchImpl?: typeof fetch;
    httpTimeoutMs?: number;
  } = {},
): Promise<
  | { ok: true; statusCode: number }
  | { ok: false; statusCode: number | null; error: string; retryable: boolean }
> {
  let rawBody: string;
  try {
    rawBody = buildDeliveryBody(
      delivery.event_id,
      delivery.event_created_at,
      delivery.payload,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      statusCode: null,
      error: `invalid event payload: ${message}`,
      retryable: false,
    };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.httpTimeoutMs ?? HTTP_TIMEOUT_MS;
  const signature = signBody(delivery.secret, rawBody);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(delivery.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Webhook-Id': delivery.webhook_id,
        'X-Event-Id': delivery.event_id,
        'X-Delivery-Id': delivery.id,
        'X-Webhook-Signature': signature,
      },
      body: rawBody,
      signal: controller.signal,
    });

    if (response.ok) {
      return { ok: true, statusCode: response.status };
    }

    if (isPermanentFailureStatus(response.status)) {
      return {
        ok: false,
        statusCode: response.status,
        error: `HTTP ${response.status}`,
        retryable: false,
      };
    }

    if (isRetryableStatus(response.status)) {
      return {
        ok: false,
        statusCode: response.status,
        error: `HTTP ${response.status}`,
        retryable: true,
      };
    }

    // Unexpected 1xx/3xx — treat as retryable network-ish failure
    return {
      ok: false,
      statusCode: response.status,
      error: `HTTP ${response.status}`,
      retryable: true,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const aborted =
      (err instanceof Error && err.name === 'AbortError') ||
      message.toLowerCase().includes('abort');
    return {
      ok: false,
      statusCode: null,
      error: aborted ? `timeout after ${timeoutMs}ms` : message,
      retryable: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function processClaimedDelivery(
  db: Db,
  delivery: ClaimedDelivery,
  opts: DeliveryWorkerOptions = {},
): Promise<DeliveryStatus> {
  const now = opts.now?.() ?? new Date();
  const result = await attemptDelivery(delivery, {
    fetchImpl: opts.fetchImpl,
    httpTimeoutMs: opts.httpTimeoutMs,
  });

  if (result.ok) {
    markDelivered(db, delivery.id, result.statusCode, now);
    logger.info('delivery succeeded', {
      deliveryId: delivery.id,
      eventId: delivery.event_id,
      webhookId: delivery.webhook_id,
      statusCode: result.statusCode,
    });
    return 'delivered';
  }

  const attemptCountAfter = delivery.attempt_count + 1;
  const status = markFailure(db, delivery.id, {
    attemptCountAfter,
    statusCode: result.statusCode,
    error: result.error,
    retryable: result.retryable,
    now,
    random: opts.random,
    maxAttempts: opts.maxAttempts,
  });

  logger.warn('delivery failed', {
    deliveryId: delivery.id,
    eventId: delivery.event_id,
    webhookId: delivery.webhook_id,
    statusCode: result.statusCode,
    error: result.error,
    nextStatus: status,
    attemptCount: attemptCountAfter,
  });

  return status;
}

export async function tick(db: Db, opts: DeliveryWorkerOptions = {}): Promise<number> {
  const now = opts.now?.() ?? new Date();
  const claimed = claimDueDeliveries(db, now);
  for (const delivery of claimed) {
    await processClaimedDelivery(db, delivery, opts);
  }
  return claimed.length;
}

export interface RunningWorker {
  stop: () => Promise<void>;
}

export function startDeliveryWorker(db: Db, opts: DeliveryWorkerOptions = {}): RunningWorker {
  const intervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const schedule = () => {
    if (stopped || inFlight) return;
    inFlight = (async () => {
      try {
        await tick(db, opts);
      } catch (err) {
        logger.error('delivery worker tick failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })().finally(() => {
      inFlight = null;
    });
  };

  const handle = setInterval(schedule, intervalMs);
  // Kick once immediately so pending work does not wait a full interval.
  schedule();

  return {
    stop: async () => {
      stopped = true;
      clearInterval(handle);
      if (inFlight) {
        await inFlight;
      }
    },
  };
}
