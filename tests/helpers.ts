import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app';
import { openDb, type Db } from '../src/db';

export interface TestContext {
  db: Db;
  baseUrl: string;
  close: () => Promise<void>;
}

export async function startTestApp(): Promise<TestContext> {
  const db = openDb(':memory:');
  const app = createApp({ db });
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
