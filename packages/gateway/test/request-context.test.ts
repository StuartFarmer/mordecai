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
  expect(clientIp(req, { trustRailwayProxy: true })).toBe('203.0.113.9');
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
    expect(clientIp(request({ 'x-real-ip': ip }), { trustRailwayProxy: true })).toBe('10.0.0.1');
  expect(clientIp(request({ 'x-real-ip': '2001:db8::1' }), { trustRailwayProxy: true })).toBe(
    '2001:db8::1',
  );
  expect(() =>
    assertSameOrigin(request({ host: 'localhost:8790', origin: 'http://localhost:8790' })),
  ).not.toThrow();
});

it('uses only the Cloudflare visitor header on Render, not a spoofable forwarded chain', () => {
  const req = request({
    host: 'demo.onrender.com',
    origin: 'https://demo.onrender.com',
    'cf-connecting-ip': '203.0.113.7',
    'x-real-ip': '198.51.100.2',
    'x-forwarded-for': '198.51.100.2, 203.0.113.7, 104.22.17.40',
    'x-forwarded-host': 'evil.example',
  });
  expect(clientIp(req)).toBe('10.0.0.1');
  expect(clientIp(req, { trustRenderProxy: true })).toBe('203.0.113.7');
  expect(() => assertSameOrigin(req)).not.toThrow();
  req.headers.origin = 'https://evil.example';
  expect(() => assertSameOrigin(req)).toThrow(/Cross-origin/);
  for (const ip of [undefined, 'fake', '203.0.113.7, 198.51.100.2', ['203.0.113.7']])
    expect(
      clientIp(request({ ...req.headers, 'cf-connecting-ip': ip }), { trustRenderProxy: true }),
    ).toBe('10.0.0.1');
  expect(clientIp(request({ 'cf-connecting-ip': '2001:db8::1' }), { trustRenderProxy: true })).toBe(
    '2001:db8::1',
  );
});
