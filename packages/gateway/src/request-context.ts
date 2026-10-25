import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

// Enable only behind Railway's HTTP edge, without a public TCP bypass to this port.
export function clientIp(req: IncomingMessage, trustRailwayProxy = false): string {
  const forwarded = req.headers['x-real-ip'];
  if (trustRailwayProxy && typeof forwarded === 'string' && isIP(forwarded)) return forwarded;
  return req.socket.remoteAddress ?? 'unknown';
}

export function assertSameOrigin(req: IncomingMessage, trustRailwayProxy = false): void {
  if (!req.headers.origin) return;
  let host = req.headers.host;
  const forwarded = req.headers['x-forwarded-host'];
  if (trustRailwayProxy && typeof forwarded === 'string') {
    const url = new URL(`https://${forwarded}`);
    if (url.host !== forwarded || url.username || url.password)
      throw new Error('Invalid forwarded host');
    host = forwarded;
  }
  const origin = new URL(req.headers.origin);
  if (!['https:', 'http:'].includes(origin.protocol) || origin.host !== host)
    throw new Error('Cross-origin writes are not allowed');
}
