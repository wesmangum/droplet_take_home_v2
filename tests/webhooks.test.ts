import { startTestApp } from './helpers';

describe('POST/GET /webhooks', () => {
  it('registers a webhook and returns a secret once', async () => {
    const ctx = await startTestApp();
    try {
      const response = await fetch(`${ctx.baseUrl}/webhooks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/hooks/a' }),
      });

      expect(response.status).toBe(201);
      const body = (await response.json()) as {
        id: string;
        url: string;
        secret: string;
        createdAt: string;
      };

      expect(body.url).toBe('https://example.com/hooks/a');
      expect(body.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(body.secret).toMatch(/^[0-9a-f]{64}$/);
      expect(body.createdAt).toEqual(expect.any(String));
    } finally {
      await ctx.close();
    }
  });

  it('rejects invalid URLs', async () => {
    const ctx = await startTestApp();
    try {
      const response = await fetch(`${ctx.baseUrl}/webhooks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'not-a-url' }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: 'invalid_request' });
    } finally {
      await ctx.close();
    }
  });

  it('rejects non-http(s) URL schemes', async () => {
    const ctx = await startTestApp();
    try {
      const response = await fetch(`${ctx.baseUrl}/webhooks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'ftp://example.com/hooks' }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: 'invalid_request' });
    } finally {
      await ctx.close();
    }
  });

  it('lists webhooks without secrets', async () => {
    const ctx = await startTestApp();
    try {
      await fetch(`${ctx.baseUrl}/webhooks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/hooks/a' }),
      });
      await fetch(`${ctx.baseUrl}/webhooks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/hooks/b' }),
      });

      const response = await fetch(`${ctx.baseUrl}/webhooks`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        webhooks: Array<Record<string, unknown>>;
      };

      expect(body.webhooks).toHaveLength(2);
      for (const webhook of body.webhooks) {
        expect(webhook).toEqual(
          expect.objectContaining({
            id: expect.any(String),
            url: expect.any(String),
            createdAt: expect.any(String),
            active: true,
          }),
        );
        expect(webhook).not.toHaveProperty('secret');
      }
    } finally {
      await ctx.close();
    }
  });
});
