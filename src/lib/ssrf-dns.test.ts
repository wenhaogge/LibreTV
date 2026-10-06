import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const dns = vi.hoisted(() => ({ resolve4: vi.fn(), resolve6: vi.fn() }));
vi.mock('node:dns/promises', () => ({ default: dns }));
import { checkUpstreamAllowed, isBlockedByDNS, isPrivateIP } from './ssrf';
import { fetchWithSafeRedirects } from './fetch-utils';
const noData = () => Object.assign(new Error('No data'), { code: 'ENODATA' });
beforeEach(() => { dns.resolve4.mockResolvedValue(['8.8.8.8']); dns.resolve6.mockResolvedValue(['2606:4700::1111']); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe('DNS fails closed', () => {
  it('accepts A-only', async () => { dns.resolve6.mockRejectedValue(noData()); expect(await isBlockedByDNS('https://a.test')).toBe(false); });
  it('accepts AAAA-only', async () => { dns.resolve4.mockRejectedValue(noData()); expect(await isBlockedByDNS('https://a.test')).toBe(false); });
  it('accepts both public families', async () => { expect(await isBlockedByDNS('https://a.test')).toBe(false); });
  it('rejects when neither family has records', async () => { dns.resolve4.mockRejectedValue(noData()); dns.resolve6.mockRejectedValue(noData()); expect(await isBlockedByDNS('https://a.test')).toBe(true); });
  it.each(['ENOTFOUND', 'ESERVFAIL', 'ETIMEOUT', 'EREFUSED'])('rejects query error %s even with public records in the other family', async (code) => {
    dns.resolve6.mockRejectedValue(Object.assign(new Error(code), { code }));
    expect((await checkUpstreamAllowed('https://a.test')).ok).toBe(false);
  });
  it('rejects mixed public/private DNS answers', async () => { dns.resolve4.mockResolvedValue(['8.8.8.8', '10.0.0.1']); expect(await isBlockedByDNS('https://a.test')).toBe(true); });
  it('rejects private IPv6 in a dual-stack domain', async () => { dns.resolve6.mockResolvedValue(['::1']); expect(await isBlockedByDNS('https://a.test')).toBe(true); });
  it.each([{ records: ['bad'] }, { records: ['::1'] }, { records: Array(65).fill('8.8.8.8') }])('rejects malformed or excessive records', async ({ records }) => { dns.resolve4.mockResolvedValue(records); expect(await isBlockedByDNS('https://a.test')).toBe(true); });
  it('bounds DNS waiting time', async () => {
    vi.useFakeTimers(); dns.resolve4.mockImplementation(() => new Promise(() => {}));
    const result = isBlockedByDNS('https://a.test');
    await vi.advanceTimersByTimeAsync(3000); expect(await result).toBe(true);
  });
  it('checks every redirect and never fetches the unverified next hop', async () => {
    dns.resolve4.mockRejectedValue(new Error('DNS unavailable'));
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://unverified.test/x' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchWithSafeRedirects('https://8.8.8.8/x')).rejects.toThrow('跳转目标被拒绝');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('does not query DNS for literal public addresses', async () => {
    expect(await isBlockedByDNS('http://[2606:4700::1111]/')).toBe(false); expect(dns.resolve4).not.toHaveBeenCalled();
  });
  it.each(['100.127.1.1', '0.1.2.3', '224.0.0.1', '198.18.0.1', '2001:db8::1', '0:0:0:0:0:0:0:1', 'ff02::1', 'garbage'])('rejects reserved or invalid address %s', (ip) => { expect(isPrivateIP(ip)).toBe(true); });
});

