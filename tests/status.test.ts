import { randomUUID } from 'node:crypto';
import type { Db } from '../src/db';
import { getStatus } from '../src/services/status';
import { startTestApp } from './helpers';

function insertDelivery(
  db: Db,
  row: {
    id?: string;
    eventId: string;
    webhookId: string;
    status: 'pending' | 'retrying' | 'delivered' | 'dead';
    attemptCount?: number;
    nextAttemptAt?: string;
    lastStatusCode?: number | null;
    lastError?: string | null;
    updatedAt?: string;
  },
): string {
  const id = row.id ?? randomUUID();
  const now = row.updatedAt ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO deliveries (
      id, event_id, webhook_id, status, attempt_count, next_attempt_at,
      last_status_code, last_error, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    row.eventId,
    row.webhookId,
    row.status,
    row.attemptCount ?? 0,
    row.nextAttemptAt ?? now,
    row.lastStatusCode ?? null,
    row.lastError ?? null,
    now,
  );
  return id;
}

describe('getStatus', () => {
  it('returns zeroed aggregates on an empty database', async () => {
    const ctx = await startTestApp();
    try {
      expect(getStatus(ctx.db)).toEqual({
        counts: { pending: 0, retrying: 0, delivered: 0, dead: 0 },
        queueDepth: 0,
        webhooks: { total: 0, active: 0 },
        events: { total: 0 },
        recentFailures: [],
      });
    } finally {
      await ctx.close();
    }
  });

  it('aggregates counts, queue depth, and recent failures', async () => {
    const ctx = await startTestApp();
    try {
      const webhook = (await (
        await fetch(`${ctx.baseUrl}/webhooks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com/hooks' }),
        })
      ).json()) as { id: string };

      const inactive = (await (
        await fetch(`${ctx.baseUrl}/webhooks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com/inactive' }),
        })
      ).json()) as { id: string };
      ctx.db.prepare(`UPDATE webhooks SET active = 0 WHERE id = ?`).run(inactive.id);

      const ingest = (await (
        await fetch(`${ctx.baseUrl}/events`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ payload: { n: 1 } }),
        })
      ).json()) as { eventId: string };

      // Ingest created one pending delivery for the active webhook; reshape for coverage.
      ctx.db.prepare(`DELETE FROM deliveries WHERE event_id = ?`).run(ingest.eventId);

      insertDelivery(ctx.db, {
        eventId: ingest.eventId,
        webhookId: webhook.id,
        status: 'pending',
      });
      insertDelivery(ctx.db, {
        eventId: ingest.eventId,
        webhookId: webhook.id,
        status: 'retrying',
        attemptCount: 2,
        lastStatusCode: 503,
        lastError: 'HTTP 503',
        updatedAt: '2026-01-02T00:00:00.000Z',
      });
      insertDelivery(ctx.db, {
        eventId: ingest.eventId,
        webhookId: webhook.id,
        status: 'delivered',
        attemptCount: 1,
        lastStatusCode: 200,
      });
      const deadId = insertDelivery(ctx.db, {
        eventId: ingest.eventId,
        webhookId: webhook.id,
        status: 'dead',
        attemptCount: 1,
        lastStatusCode: 400,
        lastError: 'HTTP 400',
        updatedAt: '2026-01-03T00:00:00.000Z',
      });

      const status = getStatus(ctx.db, { recentFailureLimit: 10 });

      expect(status.counts).toEqual({
        pending: 1,
        retrying: 1,
        delivered: 1,
        dead: 1,
      });
      expect(status.queueDepth).toBe(2);
      expect(status.webhooks).toEqual({ total: 2, active: 1 });
      expect(status.events).toEqual({ total: 1 });
      expect(status.recentFailures).toHaveLength(2);
      expect(status.recentFailures[0]).toMatchObject({
        id: deadId,
        eventId: ingest.eventId,
        webhookId: webhook.id,
        status: 'dead',
        attemptCount: 1,
        lastStatusCode: 400,
        lastError: 'HTTP 400',
        updatedAt: '2026-01-03T00:00:00.000Z',
      });
      expect(status.recentFailures[1]).toMatchObject({
        status: 'retrying',
        lastError: 'HTTP 503',
        updatedAt: '2026-01-02T00:00:00.000Z',
      });
    } finally {
      await ctx.close();
    }
  });

  it('omits retrying/dead rows without last_error from recentFailures', async () => {
    const ctx = await startTestApp();
    try {
      const webhook = (await (
        await fetch(`${ctx.baseUrl}/webhooks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com/hooks' }),
        })
      ).json()) as { id: string };

      const eventId = randomUUID();
      ctx.db
        .prepare(`INSERT INTO events (id, payload, created_at) VALUES (?, ?, ?)`)
        .run(eventId, '{}', new Date().toISOString());

      insertDelivery(ctx.db, {
        eventId,
        webhookId: webhook.id,
        status: 'retrying',
        attemptCount: 1,
        lastError: null,
      });

      expect(getStatus(ctx.db).recentFailures).toEqual([]);
    } finally {
      await ctx.close();
    }
  });
});

describe('GET /status', () => {
  it('exposes status aggregates over HTTP', async () => {
    const ctx = await startTestApp();
    try {
      await fetch(`${ctx.baseUrl}/webhooks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/a' }),
      });
      await fetch(`${ctx.baseUrl}/webhooks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/b' }),
      });

      await fetch(`${ctx.baseUrl}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payload: { hello: 'world' } }),
      });

      const response = await fetch(`${ctx.baseUrl}/status`);
      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        counts: Record<string, number>;
        queueDepth: number;
        webhooks: { total: number; active: number };
        events: { total: number };
        recentFailures: unknown[];
      };

      expect(body.counts).toEqual({
        pending: 2,
        retrying: 0,
        delivered: 0,
        dead: 0,
      });
      expect(body.queueDepth).toBe(2);
      expect(body.webhooks).toEqual({ total: 2, active: 2 });
      expect(body.events).toEqual({ total: 1 });
      expect(body.recentFailures).toEqual([]);
    } finally {
      await ctx.close();
    }
  });

  it('returns recentFailures over HTTP with camelCase fields', async () => {
    const ctx = await startTestApp();
    try {
      const webhook = (await (
        await fetch(`${ctx.baseUrl}/webhooks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com/hooks' }),
        })
      ).json()) as { id: string };

      const eventId = randomUUID();
      ctx.db
        .prepare(`INSERT INTO events (id, payload, created_at) VALUES (?, ?, ?)`)
        .run(eventId, JSON.stringify({ n: 1 }), '2026-01-01T00:00:00.000Z');

      const deadId = insertDelivery(ctx.db, {
        eventId,
        webhookId: webhook.id,
        status: 'dead',
        attemptCount: 1,
        lastStatusCode: 400,
        lastError: 'HTTP 400',
        updatedAt: '2026-01-03T00:00:00.000Z',
      });
      insertDelivery(ctx.db, {
        eventId,
        webhookId: webhook.id,
        status: 'retrying',
        attemptCount: 2,
        lastStatusCode: 503,
        lastError: 'HTTP 503',
        updatedAt: '2026-01-02T00:00:00.000Z',
      });

      const response = await fetch(`${ctx.baseUrl}/status`);
      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        counts: Record<string, number>;
        queueDepth: number;
        recentFailures: Array<Record<string, unknown>>;
      };

      expect(body.counts).toEqual({
        pending: 0,
        retrying: 1,
        delivered: 0,
        dead: 1,
      });
      expect(body.queueDepth).toBe(1);
      expect(body.recentFailures).toHaveLength(2);
      expect(body.recentFailures[0]).toEqual({
        id: deadId,
        eventId,
        webhookId: webhook.id,
        status: 'dead',
        attemptCount: 1,
        lastStatusCode: 400,
        lastError: 'HTTP 400',
        updatedAt: '2026-01-03T00:00:00.000Z',
      });
      expect(body.recentFailures[1]).toMatchObject({
        status: 'retrying',
        lastError: 'HTTP 503',
        updatedAt: '2026-01-02T00:00:00.000Z',
      });
      expect(body.recentFailures[0]).not.toHaveProperty('event_id');
      expect(body.recentFailures[0]).not.toHaveProperty('last_error');
    } finally {
      await ctx.close();
    }
  });
});
