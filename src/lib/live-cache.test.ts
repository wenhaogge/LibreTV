import { afterEach, describe, expect, it, vi } from 'vitest';
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
describe('live cache budgets', () => {
  it('rejects a single oversized entry instead of retaining it', async () => {
    vi.resetModules(); const cache = await import('./live-cache'); vi.stubEnv('LIVE_CACHE_MAX_BYTES', '65536');
    expect(cache.setLiveCache('large', {}, 1000, 65537)).toBe(false); expect(cache.getLiveCache('large')).toBeUndefined();
  });
  it('evicts oldest entries to satisfy byte and entry limits', async () => {
    vi.resetModules(); const cache = await import('./live-cache'); vi.stubEnv('LIVE_CACHE_MAX_BYTES', '131072');
    cache.setLiveCache('a', 1, 1000, 65536); cache.setLiveCache('b', 2, 1000, 65536); cache.setLiveCache('c', 3, 1000, 65536);
    expect(cache.getLiveCache('a')).toBeUndefined(); expect(cache.getLiveCache('b')).toBe(2);
    vi.stubEnv('LIVE_CACHE_MAX_ENTRIES', '1'); cache.setLiveCache('d', 4, 1000, 65536);
    expect(cache.getLiveCache('b')).toBeUndefined(); expect(cache.getLiveCache('d')).toBe(4);
  });
  it('expires at the TTL boundary and handles replacement without extra eviction', async () => {
    vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(1000); const cache = await import('./live-cache');
    vi.stubEnv('LIVE_CACHE_MAX_ENTRIES', '2');
    cache.setLiveCache('a', 1, 100); cache.setLiveCache('b', 2, 100); cache.setLiveCache('b', 3, 100);
    expect(cache.getLiveCache('a')).toBe(1); vi.setSystemTime(1100); expect(cache.getLiveCache('b')).toBeUndefined();
  });
});

