import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { isBlockedByDNS } from './ssrf';

type DnsReply = { Status: number; TC: boolean; Question: { name: string; type: number }[]; Answer?: { type: number; data: string }[] };
function resolver(change: (reply: DnsReply, type: number) => void = () => {}) {
  const fetchMock = vi.fn(async (input: URL) => {
    const type = input.searchParams.get('type') === 'A' ? 1 : 28;
    const reply: DnsReply = { Status: 0, TC: false, Question: [{ name: 'fixture.test', type }],
      Answer: [{ type, data: type === 1 ? '8.8.8.8' : '2606:4700::1111' }] };
    change(reply, type);
    return Response.json(reply);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
beforeEach(() => { vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' }); });
afterEach(() => { vi.unstubAllGlobals(); });
it.each([1, 28])('accepts a single public record family %s with NOERROR/NODATA in the other', async (family) => {
  resolver((r, type) => { if (type !== family) delete r.Answer; });
  expect(await isBlockedByDNS('https://fixture.test')).toBe(false);
});
it('accepts dual stack and fixes the resolver, deadline and redirect policy', async () => {
  const mock = resolver(); expect(await isBlockedByDNS('https://fixture.test')).toBe(false);
  expect(mock).toHaveBeenCalledTimes(2);
  expect(mock).toHaveBeenCalledWith(expect.objectContaining({ hostname: 'cloudflare-dns.com' }), expect.objectContaining({ redirect: 'manual', signal: expect.any(AbortSignal) }));
});
it.each([2, 3, 5])('rejects DNS status %s even if the other family is public', async (status) => {
  resolver((r, type) => { if (type === 28) r.Status = status; });
  expect(await isBlockedByDNS('https://fixture.test')).toBe(true);
});
it('rejects both families absent', async () => {
  resolver(r => { delete r.Answer; }); expect(await isBlockedByDNS('https://fixture.test')).toBe(true);
});
it.each(['truncated', 'wrong question', 'private', 'wrong family', 'too many'])('rejects %s answers', async mode => {
  resolver(r => {
    if (mode === 'truncated') r.TC = true;
    if (mode === 'wrong question') r.Question[0].name = 'other.test';
    if (mode === 'private') r.Answer![0].data = '10.0.0.1';
    if (mode === 'wrong family') r.Answer![0].type = 99;
    if (mode === 'too many') r.Answer = Array(65).fill(r.Answer![0]);
  });
  expect(await isBlockedByDNS('https://fixture.test')).toBe(true);
});
it('cancels oversized streamed resolver bodies', async () => {
  const cancel = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(16384)); }, cancel,
  }))));
  expect(await isBlockedByDNS('https://fixture.test')).toBe(true);
  expect(cancel).toHaveBeenCalledTimes(2);
});
it('fails closed on transport or invalid JSON responses', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  expect(await isBlockedByDNS('https://fixture.test')).toBe(true);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('not-json')));
  expect(await isBlockedByDNS('https://fixture.test')).toBe(true);
});
it('rejects resolver redirects without following them', async () => {
  const mock = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }));
  vi.stubGlobal('fetch', mock);
  expect(await isBlockedByDNS('https://fixture.test')).toBe(true);
  expect(mock).toHaveBeenCalledTimes(2);
});
