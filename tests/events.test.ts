import { extractEventPayload } from '../src/routes/events';
import { startTestApp } from './helpers';

describe('extractEventPayload', () => {
  it('uses the payload field when present', () => {
    expect(extractEventPayload({ payload: { hello: 'world' } })).toEqual({ hello: 'world' });
  });

  it('uses the whole object when payload is absent', () => {
    expect(extractEventPayload({ type: 'order.created', id: 1 })).toEqual({
      type: 'order.created',
      id: 1,
    });
  });

  it('rejects non-objects', () => {
    expect(extractEventPayload(null)).toBeUndefined();
    expect(extractEventPayload('x')).toBeUndefined();
    expect(extractEventPayload([1, 2])).toBeUndefined();
  });
});

describe('POST/GET /events', () => {
  it('ingests an event and enqueues a delivery per active webhook', async () => {
    const ctx = await startTestApp();
    try {
      const a = await (
        await fetch(`${ctx.baseUrl}/webhooks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com/a' }),
        })
      ).json() as { id: string };

      const b = await (
        await fetch(`${ctx.baseUrl}/webhooks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com/b' }),
        })
      ).json() as { id: string };

      const ingest = await fetch(`${ctx.baseUrl}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payload: { type: 'ping', n: 1 } }),
      });

      expect(ingest.status).toBe(202);
      const ingestBody = (await ingest.json()) as {
        eventId: string;
        deliveryCount: number;
      };
      expect(ingestBody.deliveryCount).toBe(2);
      expect(ingestBody.eventId).toEqual(expect.any(String));

      const get = await fetch(`${ctx.baseUrl}/events/${ingestBody.eventId}`);
      expect(get.status).toBe(200);
      const event = (await get.json()) as {
        id: string;
        payload: unknown;
        deliveries: Array<{ webhookId: string; status: string; attemptCount: number }>;
      };

      expect(event.id).toBe(ingestBody.eventId);
      expect(event.payload).toEqual({ type: 'ping', n: 1 });
      expect(event.deliveries).toHaveLength(2);
      expect(event.deliveries.map((d) => d.webhookId).sort()).toEqual([a.id, b.id].sort());
      expect(event.deliveries.every((d) => d.status === 'pending')).toBe(true);
      expect(event.deliveries.every((d) => d.attemptCount === 0)).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  it('accepts a raw JSON object as the event payload', async () => {
    const ctx = await startTestApp();
    try {
      const ingest = await fetch(`${ctx.baseUrl}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'raw' }),
      });

      expect(ingest.status).toBe(202);
      const { eventId } = (await ingest.json()) as { eventId: string };

      const get = await fetch(`${ctx.baseUrl}/events/${eventId}`);
      const event = (await get.json()) as { payload: unknown };
      expect(event.payload).toEqual({ type: 'raw' });
    } finally {
      await ctx.close();
    }
  });

  it('enqueues zero deliveries when no webhooks are registered', async () => {
    const ctx = await startTestApp();
    try {
      const ingest = await fetch(`${ctx.baseUrl}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payload: { ok: true } }),
      });

      expect(ingest.status).toBe(202);
      await expect(ingest.json()).resolves.toMatchObject({ deliveryCount: 0 });
    } finally {
      await ctx.close();
    }
  });

  it('skips inactive webhooks when enqueueing deliveries', async () => {
    const ctx = await startTestApp();
    try {
      const active = (await (
        await fetch(`${ctx.baseUrl}/webhooks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com/active' }),
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

      const ingest = await fetch(`${ctx.baseUrl}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payload: { only: 'active' } }),
      });

      expect(ingest.status).toBe(202);
      const ingestBody = (await ingest.json()) as {
        eventId: string;
        deliveryCount: number;
      };
      expect(ingestBody.deliveryCount).toBe(1);

      const event = (await (
        await fetch(`${ctx.baseUrl}/events/${ingestBody.eventId}`)
      ).json()) as {
        deliveries: Array<{ webhookId: string }>;
      };

      expect(event.deliveries).toHaveLength(1);
      expect(event.deliveries[0]?.webhookId).toBe(active.id);
    } finally {
      await ctx.close();
    }
  });

  it('returns 400 for non-object event bodies', async () => {
    const ctx = await startTestApp();
    try {
      const asArray = await fetch(`${ctx.baseUrl}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([1, 2, 3]),
      });
      expect(asArray.status).toBe(400);
      await expect(asArray.json()).resolves.toMatchObject({ error: 'invalid_request' });

      const asString = await fetch(`${ctx.baseUrl}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify('nope'),
      });
      expect(asString.status).toBe(400);
    } finally {
      await ctx.close();
    }
  });

  it('returns 404 for unknown events', async () => {
    const ctx = await startTestApp();
    try {
      const response = await fetch(
        `${ctx.baseUrl}/events/00000000-0000-4000-8000-000000000000`,
      );
      expect(response.status).toBe(404);
    } finally {
      await ctx.close();
    }
  });

  it('returns 400 for non-UUID event ids', async () => {
    const ctx = await startTestApp();
    try {
      const response = await fetch(`${ctx.baseUrl}/events/not-a-uuid`);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: 'invalid_event_id' });
    } finally {
      await ctx.close();
    }
  });
});
