import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app';
import { openDb } from '../src/db';

describe('scaffold smoke', () => {
  it('boots the Express app and responds on /health', async () => {
    const db = openDb(':memory:');
    const app = createApp({ db });
    const server = http.createServer(app);

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      db.close();
    }
  });

  it('applies the SQLite schema on open', () => {
    const db = openDb(':memory:');
    try {
      const tables = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('webhooks', 'events', 'deliveries') ORDER BY name`,
        )
        .all() as Array<{ name: string }>;

      expect(tables.map((t) => t.name)).toEqual(['deliveries', 'events', 'webhooks']);
    } finally {
      db.close();
    }
  });
});
