import { verifySignature } from '../src/services/hmac';
import { startHarness, startTestReceiver, waitFor } from './helpers';

describe('e2e harness — happy path', () => {
  it('registers webhooks, ingests an event, and delivers signed payloads', async () => {
    const harness = await startHarness();
    const receiverA = await startTestReceiver();
    const receiverB = await startTestReceiver();

    try {
      const webhookA = (await (
        await fetch(`${harness.baseUrl}/webhooks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: `${receiverA.baseUrl}/hooks` }),
        })
      ).json()) as { id: string; secret: string };

      const webhookB = (await (
        await fetch(`${harness.baseUrl}/webhooks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: `${receiverB.baseUrl}/hooks` }),
        })
      ).json()) as { id: string; secret: string };

      const ingest = await fetch(`${harness.baseUrl}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payload: { type: 'order.created', amount: 42 } }),
      });
      expect(ingest.status).toBe(202);
      const { eventId, deliveryCount } = (await ingest.json()) as {
        eventId: string;
        deliveryCount: number;
      };
      expect(deliveryCount).toBe(2);

      await waitFor(
        () => receiverA.requests.length === 1 && receiverB.requests.length === 1,
        { message: 'expected both receivers to get the delivery' },
      );

      for (const [receiver, webhook] of [
        [receiverA, webhookA],
        [receiverB, webhookB],
      ] as const) {
        const req = receiver.requests[0]!;
        expect(req.method).toBe('POST');
        expect(req.url).toBe('/hooks');
        expect(req.headers['content-type']).toMatch(/application\/json/);
        expect(req.headers['x-webhook-id']).toBe(webhook.id);
        expect(req.headers['x-event-id']).toBe(eventId);
        expect(req.headers['x-delivery-id']).toEqual(expect.any(String));

        const signature = req.headers['x-webhook-signature'];
        expect(typeof signature).toBe('string');
        expect(verifySignature(webhook.secret, req.body, signature as string)).toBe(true);

        const body = JSON.parse(req.body) as {
          id: string;
          createdAt: string;
          data: unknown;
        };
        expect(body.id).toBe(eventId);
        expect(body.createdAt).toEqual(expect.any(String));
        expect(body.data).toEqual({ type: 'order.created', amount: 42 });
      }

      await waitFor(async () => {
        const status = (await (await fetch(`${harness.baseUrl}/status`)).json()) as {
          counts: { delivered: number; pending: number; retrying: number; dead: number };
          queueDepth: number;
        };
        return status.counts.delivered === 2 && status.queueDepth === 0;
      }, { message: 'expected /status to show both deliveries as delivered' });

      const event = (await (
        await fetch(`${harness.baseUrl}/events/${eventId}`)
      ).json()) as {
        deliveries: Array<{ status: string; attemptCount: number }>;
      };
      expect(event.deliveries).toHaveLength(2);
      expect(event.deliveries.every((d) => d.status === 'delivered')).toBe(true);
      expect(event.deliveries.every((d) => d.attemptCount === 1)).toBe(true);
    } finally {
      await harness.close();
      await receiverA.close();
      await receiverB.close();
    }
  });
});
