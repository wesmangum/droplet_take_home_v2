import { signBody, verifySignature } from '../src/services/hmac';

describe('hmac', () => {
  const secret = 'test-secret';
  const body = JSON.stringify({ id: 'evt_1', createdAt: '2026-01-01T00:00:00.000Z', data: { a: 1 } });

  it('signs with sha256= prefix', () => {
    const signature = signBody(secret, body);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('is stable for the same secret and body', () => {
    expect(signBody(secret, body)).toBe(signBody(secret, body));
  });

  it('verifies a valid signature', () => {
    const signature = signBody(secret, body);
    expect(verifySignature(secret, body, signature)).toBe(true);
  });

  it('rejects tampered bodies and wrong secrets', () => {
    const signature = signBody(secret, body);
    expect(verifySignature(secret, body + 'x', signature)).toBe(false);
    expect(verifySignature('other', body, signature)).toBe(false);
    expect(verifySignature(secret, body, 'sha256=deadbeef')).toBe(false);
  });
});
