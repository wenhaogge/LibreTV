/** Conservative per-isolate starting limits, not a production memory guarantee. */
const MiB = 1024 * 1024;
function bounded(name: string, fallback: number, maximum: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}
export function getEpgLimits() {
  return {
    inputBytes: bounded('EPG_MAX_INPUT_BYTES', MiB, 4 * MiB),
    outputBytes: bounded('EPG_MAX_OUTPUT_BYTES', 4 * MiB, 8 * MiB),
    programmes: bounded('EPG_MAX_PROGRAMMES', 10000, 20000),
    scannedProgrammes: bounded('EPG_MAX_SCANNED_PROGRAMMES', 50000, 100000),
    channels: bounded('EPG_MAX_CHANNELS', 1000, 2000),
    parsedBytes: bounded('EPG_MAX_PARSED_BYTES', 4 * MiB, 8 * MiB),
    fieldChars: bounded('EPG_MAX_FIELD_CHARS', 16384, 32768),
    concurrency: bounded('EPG_MAX_CONCURRENCY', 1, 2),
    cacheBytes: bounded('LIVE_CACHE_MAX_BYTES', 8 * MiB, 16 * MiB),
    cacheEntries: bounded('LIVE_CACHE_MAX_ENTRIES', 10, 50),
  };
}
export class EpgLimitError extends Error {
  constructor(message: string) { super(message); this.name = 'EpgLimitError'; }
}
let active = 0;
export function acquireEpgSlot(): (() => void) | null {
  if (active >= getEpgLimits().concurrency) return null;
  active++;
  let released = false;
  return () => { if (!released) { released = true; active--; } };
}

/** Limit while reading, including responses with missing/false Content-Length. */
export async function readEpgBody(response: Response): Promise<Buffer> {
  const limit = getEpgLimits().inputBytes;
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw new EpgLimitError('节目单响应体超过输入大小上限');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new EpgLimitError('节目单响应体超过输入大小上限');
      chunks.push(value);
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

