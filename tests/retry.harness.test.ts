import { verifySignature } from '../src/services/hmac';
import { startHarness, startTestReceiver, waitFor } from './helpers';

describe('e2e harness — retry then success', () => {
  it('retries a 5xx delivery and eventually delivers with a valid signature', async () => {
    const harness = await startHarness();
    let hits = 0;

    const receiver = await startTestReceiver((_req, res) => {
      hits += 1;
      if (hits === 1) {
        res.statusCode = 500;
        res.end('temporary failure');
        return;
      }
      res.statusCode = 200;
      res.end('ok');
    });

    try {
      const webhook = (await (
        await fetch(`${harness.baseUrl}/webhooks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: `${receiver.baseUrl}/hook` }),
        })
      ).json()) as { id: string; secret: string };

      const ingest = await fetch(`${harness.baseUrl}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payload: { type: 'retry.me' } }),
      });
      expect(ingest.status).toBe(202);
      const { eventId } = (await ingest.json()) as { eventId: string };

      await waitFor(() => receiver.requests.length >= 1, {
        message: 'expected first (failed) delivery attempt',
      });

      await waitFor(async () => {
        const event = (await (
          await fetch(`${harness.baseUrl}/events/${eventId}`)
        ).json()) as {
          deliveries: Array<{ status: string; attemptCount: number; lastStatusCode: number | null }>;
        };
        const delivery = event.deliveries[0];
        return (
          delivery?.status === 'retrying' &&
          delivery.attemptCount === 1 &&
          delivery.lastStatusCode === 500
        );
      }, { message: 'expected delivery to enter retrying after 5xx' });

      await waitFor(() => receiver.requests.length >= 2, {
        message: 'expected second (successful) delivery attempt',
      });

      await waitFor(async () => {
        const status = (await (await fetch(`${harness.baseUrl}/status`)).json()) as {
          counts: { delivered: number; retrying: number; dead: number };
          queueDepth: number;
        };
        return status.counts.delivered === 1 && status.queueDepth === 0;
      }, { message: 'expected /status to show delivered after retry' });

      expect(hits).toBe(2);
      expect(receiver.requests).toHaveLength(2);

      const success = receiver.requests[1]!;
      const signature = success.headers['x-webhook-signature'];
      expect(typeof signature).toBe('string');
      expect(verifySignature(webhook.secret, success.body, signature as string)).toBe(true);
      expect(JSON.parse(success.body)).toMatchObject({
        id: eventId,
        data: { type: 'retry.me' },
      });

      const event = (await (
        await fetch(`${harness.baseUrl}/events/${eventId}`)
      ).json()) as {
        deliveries: Array<{ status: string; attemptCount: number; lastStatusCode: number | null }>;
      };
      expect(event.deliveries[0]).toMatchObject({
        status: 'delivered',
        attemptCount: 2,
        lastStatusCode: 200,
      });
    } finally {
      await harness.close();
      await receiver.close();
    }
  });

  it('marks permanent 4xx failures dead without spinning', async () => {
    const harness = await startHarness();
    let hits = 0;

    const receiver = await startTestReceiver((_req, res) => {
      hits += 1;
      res.statusCode = 400;
      res.end('bad request');
    });

    try {
      await fetch(`${harness.baseUrl}/webhooks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: `${receiver.baseUrl}/hook` }),
      });

      const { eventId } = (await (
        await fetch(`${harness.baseUrl}/events`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ payload: { type: 'bad' } }),
        })
      ).json()) as { eventId: string };

      await waitFor(async () => {
        const status = (await (await fetch(`${harness.baseUrl}/status`)).json()) as {
          counts: { dead: number; pending: number; retrying: number };
          queueDepth: number;
          recentFailures: Array<{ status: string; lastStatusCode: number | null }>;
        };
        return (
          status.counts.dead === 1 &&
          status.queueDepth === 0 &&
          status.recentFailures[0]?.lastStatusCode === 400
        );
      }, { message: 'expected /status to show a dead 4xx delivery' });

      // Give the worker a couple more poll cycles; it must not keep hitting the receiver.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(hits).toBe(1);
      expect(receiver.requests).toHaveLength(1);

      const event = (await (
        await fetch(`${harness.baseUrl}/events/${eventId}`)
      ).json()) as {
        deliveries: Array<{ status: string; attemptCount: number }>;
      };
      expect(event.deliveries[0]).toMatchObject({
        status: 'dead',
        attemptCount: 1,
      });
    } finally {
      await harness.close();
      await receiver.close();
    }
  });
});
