import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db';
import { ingestEvent } from '../src/services/events';
import {
  attemptDelivery,
  claimDueDeliveries,
  computeBackoffMs,
  isPermanentFailureStatus,
  isRetryableStatus,
  markFailure,
  processClaimedDelivery,
  startDeliveryWorker,
  tick,
} from '../src/services/deliveryWorker';
import { verifySignature } from '../src/services/hmac';
import { createWebhook } from '../src/services/webhooks';

describe('retry policy helpers', () => {
  it('retries 5xx and 429, not other 4xx', () => {
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isPermanentFailureStatus(400)).toBe(true);
    expect(isPermanentFailureStatus(404)).toBe(true);
    expect(isPermanentFailureStatus(429)).toBe(false);
  });

  it('computes bounded backoff with jitter', () => {
    expect(computeBackoffMs(1, () => 0)).toBe(0);
    expect(computeBackoffMs(1, () => 0.999, 1000, 60_000)).toBe(999);
    expect(computeBackoffMs(3, () => 1, 1000, 60_000)).toBe(4000);
    expect(computeBackoffMs(10, () => 1, 1000, 5000)).toBe(5000);
  });
});

describe('delivery worker', () => {
  it('delivers successfully with a valid HMAC signature', async () => {
    const db = openDb(':memory:');
    const received: Array<{
      headers: http.IncomingHttpHeaders;
      body: string;
    }> = [];

    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        received.push({ headers: req.headers, body });
        res.statusCode = 200;
        res.end('ok');
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    const webhook = createWebhook(db, `http://127.0.0.1:${port}/hook`);
    const { eventId } = ingestEvent(db, { hello: 'world' });

    try {
      const processed = await tick(db, { now: () => new Date(), random: () => 0 });
      expect(processed).toBe(1);
      expect(received).toHaveLength(1);

      const signature = received[0]!.headers['x-webhook-signature'];
      expect(typeof signature).toBe('string');
      expect(verifySignature(webhook.secret, received[0]!.body, signature as string)).toBe(true);

      const parsed = JSON.parse(received[0]!.body) as {
        id: string;
        data: unknown;
      };
      expect(parsed.id).toBe(eventId);
      expect(parsed.data).toEqual({ hello: 'world' });
      expect(received[0]!.headers['x-webhook-id']).toBe(webhook.id);
      expect(received[0]!.headers['x-event-id']).toBe(eventId);

      const row = db
        .prepare(`SELECT status, attempt_count FROM deliveries WHERE event_id = ?`)
        .get(eventId) as { status: string; attempt_count: number };
      expect(row).toEqual({ status: 'delivered', attempt_count: 1 });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      db.close();
    }
  });

  it('retries on 5xx then can succeed on a later tick', async () => {
    const db = openDb(':memory:');
    let hits = 0;
    const server = http.createServer((_req, res) => {
      hits += 1;
      if (hits === 1) {
        res.statusCode = 500;
        res.end('nope');
        return;
      }
      res.statusCode = 200;
      res.end('ok');
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    createWebhook(db, `http://127.0.0.1:${port}/hook`);
    const { eventId } = ingestEvent(db, { n: 1 });

    const t0 = new Date('2026-01-01T00:00:00.000Z');
    db.prepare(`UPDATE deliveries SET next_attempt_at = ? WHERE event_id = ?`).run(
      t0.toISOString(),
      eventId,
    );

    try {
      await tick(db, { now: () => t0, random: () => 0 });
      const afterFail = db
        .prepare(`SELECT status, attempt_count FROM deliveries WHERE event_id = ?`)
        .get(eventId) as { status: string; attempt_count: number };
      expect(afterFail.status).toBe('retrying');
      expect(afterFail.attempt_count).toBe(1);

      // random=0 => backoff 0, so next_attempt_at === t0; advance clock to re-claim.
      const t1 = new Date(t0.getTime() + 1);
      await tick(db, { now: () => t1, random: () => 0 });
      const afterOk = db
        .prepare(`SELECT status, attempt_count FROM deliveries WHERE event_id = ?`)
        .get(eventId) as { status: string; attempt_count: number };
      expect(afterOk).toEqual({ status: 'delivered', attempt_count: 2 });
      expect(hits).toBe(2);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      db.close();
    }
  });

  it('marks dead on permanent 4xx without retrying', async () => {
    const db = openDb(':memory:');
    let hits = 0;
    const server = http.createServer((_req, res) => {
      hits += 1;
      res.statusCode = 400;
      res.end('bad');
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    createWebhook(db, `http://127.0.0.1:${port}/hook`);
    const { eventId } = ingestEvent(db, { n: 1 });

    try {
      await tick(db, { now: () => new Date(), random: () => 0 });
      await tick(db, { now: () => new Date(Date.now() + 60_000), random: () => 0 });

      const row = db
        .prepare(`SELECT status, attempt_count, last_status_code FROM deliveries WHERE event_id = ?`)
        .get(eventId) as { status: string; attempt_count: number; last_status_code: number };
      expect(row).toEqual({ status: 'dead', attempt_count: 1, last_status_code: 400 });
      expect(hits).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      db.close();
    }
  });

  it('marks dead after max retryable attempts', async () => {
    const db = openDb(':memory:');
    createWebhook(db, 'https://example.com/hook');
    const { eventId } = ingestEvent(db, { n: 1 });
    const deliveryId = (
      db.prepare(`SELECT id FROM deliveries WHERE event_id = ?`).get(eventId) as { id: string }
    ).id;

    const fetchImpl: typeof fetch = async () =>
      new Response('nope', { status: 503 }) as unknown as Response;

    let now = new Date('2026-01-01T00:00:00.000Z');
    for (let i = 0; i < 5; i += 1) {
      db.prepare(`UPDATE deliveries SET next_attempt_at = ? WHERE id = ?`).run(
        now.toISOString(),
        deliveryId,
      );
      const claimed = claimDueDeliveries(db, now)[0];
      expect(claimed).toBeDefined();
      await processClaimedDelivery(db, claimed!, {
        fetchImpl,
        now: () => now,
        random: () => 0,
        maxAttempts: 5,
      });
      now = new Date(now.getTime() + 1);
    }

    const row = db
      .prepare(`SELECT status, attempt_count FROM deliveries WHERE id = ?`)
      .get(deliveryId) as { status: string; attempt_count: number };
    expect(row).toEqual({ status: 'dead', attempt_count: 5 });
    db.close();
  });

  it('treats network/timeout failures as retryable', async () => {
    const delivery = {
      id: 'd1',
      event_id: 'e1',
      webhook_id: 'w1',
      status: 'pending' as const,
      attempt_count: 0,
      url: 'http://127.0.0.1:9',
      secret: 's',
      payload: '{"a":1}',
      event_created_at: '2026-01-01T00:00:00.000Z',
    };

    const fetchImpl: typeof fetch = async () => {
      throw new Error('connect ECONNREFUSED');
    };

    const result = await attemptDelivery(delivery, { fetchImpl, httpTimeoutMs: 50 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.statusCode).toBeNull();
    }

    const db = openDb(':memory:');
    // markFailure unit path
    db.exec(`
      INSERT INTO webhooks (id, url, secret, created_at, active) VALUES ('w1', 'http://x', 's', 't', 1);
      INSERT INTO events (id, payload, created_at) VALUES ('e1', '{}', 't');
      INSERT INTO deliveries (id, event_id, webhook_id, status, attempt_count, next_attempt_at, last_status_code, last_error, updated_at)
      VALUES ('d1', 'e1', 'w1', 'pending', 0, 't', NULL, NULL, 't');
    `);
    const status = markFailure(db, 'd1', {
      attemptCountAfter: 1,
      statusCode: null,
      error: 'connect ECONNREFUSED',
      retryable: true,
      now: new Date('2026-01-01T00:00:00.000Z'),
      random: () => 0,
    });
    expect(status).toBe('retrying');
    db.close();
  });

  it('marks poison payloads dead without calling the webhook', async () => {
    const db = openDb(':memory:');
    let hits = 0;
    const fetchImpl: typeof fetch = async () => {
      hits += 1;
      return new Response('ok', { status: 200 }) as unknown as Response;
    };

    createWebhook(db, 'https://example.com/hook');
    const { eventId } = ingestEvent(db, { ok: true });
    db.prepare(`UPDATE events SET payload = ? WHERE id = ?`).run('{not-json', eventId);

    const now = new Date();
    await tick(db, { now: () => now, fetchImpl, random: () => 0 });

    const row = db
      .prepare(`SELECT status, attempt_count, last_error FROM deliveries WHERE event_id = ?`)
      .get(eventId) as { status: string; attempt_count: number; last_error: string };
    expect(row.status).toBe('dead');
    expect(row.attempt_count).toBe(1);
    expect(row.last_error).toMatch(/invalid event payload/i);
    expect(hits).toBe(0);
    db.close();
  });

  it('does not start overlapping ticks and stop() awaits in-flight work', async () => {
    const db = openDb(':memory:');
    createWebhook(db, 'https://example.com/hook');
    ingestEvent(db, { n: 1 });

    let concurrent = 0;
    let maxConcurrent = 0;
    let releases = 0;
    const gate: Array<() => void> = [];

    const fetchImpl: typeof fetch = async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise<void>((resolve) => {
        gate.push(resolve);
      });
      concurrent -= 1;
      releases += 1;
      return new Response('ok', { status: 200 }) as unknown as Response;
    };

    const worker = startDeliveryWorker(db, {
      pollIntervalMs: 20,
      fetchImpl,
      random: () => 0,
    });

    // Wait until the first tick has claimed and entered fetch.
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (gate.length > 0) {
          clearInterval(check);
          resolve();
        }
      }, 5);
    });

    // Allow several interval firings while the first tick is blocked.
    await new Promise((r) => setTimeout(r, 80));
    expect(maxConcurrent).toBe(1);

    // stop() should wait for the in-flight tick; release only after stop is pending.
    const stopPromise = worker.stop();
    for (const release of gate.splice(0)) {
      release();
    }
    await stopPromise;
    expect(releases).toBeGreaterThanOrEqual(1);

    // After stop, further interval callbacks must not run new work.
    const before = releases;
    await new Promise((r) => setTimeout(r, 60));
    expect(releases).toBe(before);

    db.close();
  });
});
