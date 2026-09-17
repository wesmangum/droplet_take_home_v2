import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app';
import { openDb, type Db } from '../src/db';
import {
  startDeliveryWorker,
  type DeliveryWorkerOptions,
  type RunningWorker,
} from '../src/services/deliveryWorker';
import { createLogger, type Logger } from '../src/services/logger';

export interface TestContext {
  db: Db;
  baseUrl: string;
  close: () => Promise<void>;
}

export interface HarnessContext extends TestContext {
  worker: RunningWorker;
}

export interface ReceivedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface TestReceiver {
  baseUrl: string;
  requests: ReceivedRequest[];
  close: () => Promise<void>;
}

const silentLogger: Logger = createLogger(() => {
  // Keep harness output quiet; assertions cover behavior.
});

export async function startTestApp(opts: { logger?: Logger } = {}): Promise<TestContext> {
  const db = openDb(':memory:');
  const app = createApp({ db, logger: opts.logger });
  const server = http.createServer(app);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const { port } = server.address() as AddressInfo;

  return {
    db,
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      db.close();
    },
  };
}

/** Full stack for e2e: API + in-process delivery worker on ephemeral ports. */
export async function startHarness(
  workerOpts: DeliveryWorkerOptions = {},
): Promise<HarnessContext> {
  const appCtx = await startTestApp({ logger: silentLogger });
  const worker = startDeliveryWorker(appCtx.db, {
    pollIntervalMs: 50,
    random: () => 0,
    ...workerOpts,
  });

  return {
    ...appCtx,
    worker,
    close: async () => {
      await worker.stop();
      await appCtx.close();
    },
  };
}

export async function startTestReceiver(
  handler?: (req: ReceivedRequest, res: http.ServerResponse) => void | Promise<void>,
): Promise<TestReceiver> {
  const requests: ReceivedRequest[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const received: ReceivedRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(received);

      void (async () => {
        await handler?.(received, res);
      })().catch(() => {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end('handler error');
        }
      });

      if (!handler && !res.writableEnded) {
        res.statusCode = 200;
        res.end('ok');
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const intervalMs = opts.intervalMs ?? 25;
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(opts.message ?? `Timed out after ${timeoutMs}ms waiting for condition`);
}
