# Webhook Delivery Service

A small Node.js service that registers webhook URLs, accepts events, and delivers them in the background. Deliveries are **at-least-once**, signed with **HMAC-SHA256**, retried on transient failures, and tracked in SQLite. You can watch the system through structured JSON logs and `GET /status`.

This is the Droplet take-home ([`WEBHOOK_DELIVERY.md`](./WEBHOOK_DELIVERY.md)). Locked design choices live in [`PLAN.md`](./PLAN.md).

## Getting started

You need **Node 20+**. The first `npm install` builds `better-sqlite3`, so a normal native toolchain (Python + build tools) must be available.

```bash
npm install
npm run dev                 # hot reload; listens on PORT (default 3000)
npm run build && npm start  # production-style run from dist/
npm test                    # Jest; no Redis or other external services
```

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `PORT` | `3000` | HTTP listen port |
| `DB_PATH` | `./data/webhooks.db` | Where SQLite stores webhooks, events, and deliveries |

## Using the API

### Register a webhook

Create a subscription by posting a URL. The response includes a **secret** — save it. Listing webhooks never returns secrets again.

```bash
curl -sS -X POST http://localhost:3000/webhooks \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/hooks"}'
```

```json
{ "id": "…", "url": "https://example.com/hooks", "secret": "…", "createdAt": "…" }
```

```bash
curl -sS http://localhost:3000/webhooks
```

```json
{ "webhooks": [{ "id": "…", "url": "…", "createdAt": "…", "active": true }] }
```

Only **active** webhooks receive new events. Inactive ones are skipped at ingest time.

### Send an event

You can wrap the data in `{ "payload": { … } }`, or send any JSON object and it will be treated as the payload.

```bash
curl -sS -X POST http://localhost:3000/events \
  -H 'content-type: application/json' \
  -d '{"payload":{"type":"order.created","amount":42}}'
```

You get a `202` once the event and delivery rows are written:

```json
{ "eventId": "…", "deliveryCount": 1 }
```

Check progress for one event:

```bash
curl -sS http://localhost:3000/events/<eventId>
```

```json
{
  "id": "…",
  "payload": { "type": "order.created", "amount": 42 },
  "createdAt": "…",
  "deliveries": [
    {
      "id": "…",
      "webhookId": "…",
      "status": "delivered",
      "attemptCount": 1,
      "nextAttemptAt": "…",
      "lastStatusCode": 200,
      "lastError": null,
      "updatedAt": "…"
    }
  ]
}
```

Or look at the whole queue:

```bash
curl -sS http://localhost:3000/status
```

```json
{
  "counts": { "pending": 0, "retrying": 0, "delivered": 1, "dead": 0 },
  "queueDepth": 0,
  "webhooks": { "total": 1, "active": 1 },
  "events": { "total": 1 },
  "recentFailures": []
}
```

`queueDepth` is pending + retrying work. `recentFailures` is up to 20 recent `retrying` / `dead` rows that have a `lastError`. There is also `GET /health` → `{ "ok": true }` for a simple liveness check.

### What your endpoint receives

For each attempt the worker posts to your URL with:

- **Headers:** `Content-Type: application/json`, `X-Webhook-Id`, `X-Event-Id`, `X-Delivery-Id`, and `X-Webhook-Signature: sha256=<hex>`
- **Body:** `{ "id": "<eventId>", "createdAt": "<iso>", "data": <payload> }`

The signature is over the **exact raw body bytes** (not a re-serialized object). You can reuse [`verifySignature`](./src/services/hmac.ts), or verify like this:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(secret, rawBody, header) {
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Because delivery is at-least-once, receivers should **dedupe on the event `id` in the body**. Use `X-Delivery-Id` if you care about a specific attempt.

## Delivery guarantees

| Topic | What happens |
| ----- | ------------ |
| Semantics | **At-least-once.** Ingest returns `202` only after the event and delivery rows are safely in SQLite. |
| Success | An HTTP `2xx` from your endpoint marks the delivery `delivered`. |
| Retries | Network errors, timeouts (**5 seconds**), `429`, and `5xx` move the row to `retrying`. Backoff is exponential with jitter (about 1s base, 60s cap), up to **5** attempts. |
| Permanent failure | Other `4xx` responses mark the delivery `dead` so the worker does not keep hammering a bad URL. |
| Worker | A single in-process poller (~every 500ms) claims due rows by bumping `next_attempt_at` (a short lease) so the same process does not send one due row twice at once. |

## Design in brief

SQLite is both the database and the queue — there is no Redis. Accepting an event is a quick synchronous write; a background worker owns the HTTP calls, timeouts, and retries so API clients stay fast. If the process crashes mid-delivery, that row can be tried again. That is intentional: better a duplicate than a silent drop. JSON logs on requests and delivery outcomes, plus `/status`, are enough observability for this MVP.

## Out of scope

These are deliberate limits, not oversights:

- Running multiple worker processes or hosts (claiming is single-process only)
- An admin UI, Prometheus metrics, or webhook CRUD beyond register + list
- Exactly-once delivery (your receiver must dedupe)
- Full SSRF protection — webhook URLs are whatever the caller registers. Do not expose registration to untrusted users without an allowlist or egress proxy. The test harness intentionally hits `127.0.0.1`.

## LLM-assisted work

This was built in Cursor, one GitHub issue/PR per milestone. Agents handled a lot of scaffolding; humans set the guarantees and what stayed out of scope (see `PLAN.md`).

For the challenge brief: Cursor transcripts located in the [`transcipts/`](./transcripts/) folder. The required pipe ASCII art is a comment in [`src/db.ts`](./src/db.ts).
