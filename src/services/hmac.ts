import { createHmac, timingSafeEqual } from 'node:crypto';

export function signBody(secret: string, rawBody: string | Buffer): string {
  const digest = createHmac('sha256', secret).update(rawBody).digest('hex');
  return `sha256=${digest}`;
}

export function verifySignature(
  secret: string,
  rawBody: string | Buffer,
  signatureHeader: string,
): boolean {
  const expected = signBody(secret, rawBody);
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, actualBuf);
}
