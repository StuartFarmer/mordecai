import type { IncomingMessage } from 'node:http';
import { expect, it } from 'vitest';
import { assertSameOrigin, clientIp } from '../src/request-context.js';

function request(headers: IncomingMessage['headers']): IncomingMessage {
  return { headers, socket: { remoteAddress: '10.0.0.1' } } as IncomingMessage;
}

it('ignores spoofable proxy headers unless explicitly configured behind Railway', () => {
  const req = request({
    host: 'internal:8790',
    origin: 'https://demo.example',
    'x-forwarded-host': 'demo.example',
    'x-real-ip': '203.0.113.9',
  });
  expect(clientIp(req)).toBe('10.0.0.1');
  expect(() => assertSameOrigin(req)).toThrow(/Cross-origin/);
  expect(clientIp(req, true)).toBe('203.0.113.9');
  expect(() => assertSameOrigin(req, true)).not.toThrow();
});

it('rejects foreign origins and malformed forwarded hosts; invalid IPs use the socket', () => {
  expect(() =>
    assertSameOrigin(
      request({
        host: 'internal',
        origin: 'https://evil.example',
        'x-forwarded-host': 'demo.example',
      }),
      true,
    ),
  ).toThrow(/Cross-origin/);
  for (const host of ['demo.example,evil.example', 'demo.example/path', 'user@demo.example'])
    expect(() =>
      assertSameOrigin(request({ origin: 'https://demo.example', 'x-forwarded-host': host }), true),
    ).toThrow();
  for (const ip of ['203.0.113.9, 10.0.0.1', 'fake', ['203.0.113.9']])
    expect(clientIp(request({ 'x-real-ip': ip }), true)).toBe('10.0.0.1');
  expect(clientIp(request({ 'x-real-ip': '2001:db8::1' }), true)).toBe('2001:db8::1');
  expect(() =>
    assertSameOrigin(request({ host: 'localhost:8790', origin: 'http://localhost:8790' })),
  ).not.toThrow();
});
