import { afterEach, describe, expect, it, vi } from 'vitest';
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('bounded instance-local rate limit', () => {
  it('does not create a timer when imported', async () => {
    vi.resetModules(); const timer = vi.spyOn(globalThis, 'setInterval');
    await import('./auth'); expect(timer).not.toHaveBeenCalled();
  });
  it('expires exactly at the ten-minute boundary and cleans on request', async () => {
    vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(1000);
    const auth = await import('./auth');
    for (let i = 0; i < 10; i++) expect(auth.checkRateLimit('a')).toBe(true);
    expect(auth.checkRateLimit('a')).toBe(false);
    vi.setSystemTime(601000); expect(auth.checkRateLimit('a')).toBe(true);
  });
  it('rejects new identities at capacity without evicting active counters, then reclaims expired entries', async () => {
    vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(1000);
    const auth = await import('./auth');
    for (let i = 0; i < 4096; i++) expect(auth.checkRateLimit('ip-' + i)).toBe(true);
    expect(auth.checkRateLimit('overflow')).toBe(false);
    for (let i = 1; i < 10; i++) expect(auth.checkRateLimit('ip-0')).toBe(true);
    expect(auth.checkRateLimit('ip-0')).toBe(false);
    auth.clearRateLimit('ip-1'); expect(auth.checkRateLimit('replacement')).toBe(true);
    vi.setSystemTime(601000); expect(auth.checkRateLimit('after-expiry')).toBe(true);
  });
  it('rejects unbounded identity keys', async () => { const auth = await import('./auth'); expect(auth.checkRateLimit('x'.repeat(257))).toBe(false); });
});

