import { randomBytes, randomUUID } from 'node:crypto';
import type { Db } from '../db';
import type { Webhook } from '../types';

export interface CreatedWebhook {
  id: string;
  url: string;
  secret: string;
  createdAt: string;
}

export interface PublicWebhook {
  id: string;
  url: string;
  createdAt: string;
  active: boolean;
}

export function createWebhook(db: Db, url: string): CreatedWebhook {
  const id = randomUUID();
  const secret = randomBytes(32).toString('hex');
  const createdAt = new Date().toISOString();

  db.prepare(
    `INSERT INTO webhooks (id, url, secret, created_at, active) VALUES (?, ?, ?, ?, 1)`,
  ).run(id, url, secret, createdAt);

  return { id, url, secret, createdAt };
}

export function listWebhooks(db: Db): PublicWebhook[] {
  const rows = db
    .prepare(
      `SELECT id, url, created_at, active FROM webhooks ORDER BY created_at ASC`,
    )
    .all() as Array<Pick<Webhook, 'id' | 'url' | 'created_at' | 'active'>>;

  return rows.map((row) => ({
    id: row.id,
    url: row.url,
    createdAt: row.created_at,
    active: row.active === 1,
  }));
}

export function listActiveWebhooks(db: Db): Webhook[] {
  return db
    .prepare(`SELECT id, url, secret, created_at, active FROM webhooks WHERE active = 1`)
    .all() as Webhook[];
}
