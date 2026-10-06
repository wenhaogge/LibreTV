import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireEpgSlot, EpgLimitError, getEpgLimits, readEpgBody } from './epg-limits';
import { parseXmltv } from './xmltv';
const programme = (id = 'c') => '<programme channel="' + id + '" start="20000101000000 +0000" stop="20990101000000 +0000"><title>test</title></programme>';
afterEach(() => { vi.unstubAllEnvs(); });
describe('bounded XMLTV ingestion', () => {
  it('parses normal plain and gzip content', () => {
    const xml = '<tv>' + programme() + '</tv>';
    expect(parseXmltv(xml).get('c')).toHaveLength(1);
    expect(parseXmltv(gzipSync(xml)).get('c')).toHaveLength(1);
  });
  it('limits input before parsing', () => { vi.stubEnv('EPG_MAX_INPUT_BYTES', '100'); expect(() => parseXmltv('x'.repeat(101))).toThrow(EpgLimitError); });
  it('limits gzip output during decompression, including a high compression ratio', () => {
    vi.stubEnv('EPG_MAX_OUTPUT_BYTES', '1024'); const bomb = gzipSync('x'.repeat(1000000));
    expect(bomb.byteLength).toBeLessThan(2048); expect(() => parseXmltv(bomb)).toThrow(/解压输出/);
  });
  it('rejects malformed gzip', () => { expect(() => parseXmltv(Buffer.from([31,139,1,2]))).toThrow(); });
  it('counts all scanned programmes, including discarded dates', () => {
    vi.stubEnv('EPG_MAX_SCANNED_PROGRAMMES', '1');
    expect(() => parseXmltv('<tv><programme channel="x" start="bad"/><programme channel="y" start="bad"/></tv>')).toThrow(/扫描/);
  });
  it('rejects rather than truncates retained programmes', () => {
    vi.stubEnv('EPG_MAX_PROGRAMMES', '1'); expect(() => parseXmltv(programme() + programme())).toThrow(/解析结果/);
  });
  it('bounds channel count', () => { vi.stubEnv('EPG_MAX_CHANNELS', '1'); expect(() => parseXmltv(programme('a') + programme('b'))).toThrow(/频道/); });
  it('bounds parsed bytes', () => { vi.stubEnv('EPG_MAX_PARSED_BYTES', '100'); expect(() => parseXmltv(programme())).toThrow(/解析结果/); });
  it('bounds field size', () => { vi.stubEnv('EPG_MAX_FIELD_CHARS', '2'); expect(() => parseXmltv(programme())).toThrow(/字段/); });
  it('reads normal chunked bodies', async () => {
    expect((await readEpgBody(new Response('normal'))).toString()).toBe('normal');
  });
  it('cancels a too-large chunked response without Content-Length', async () => {
    vi.stubEnv('EPG_MAX_INPUT_BYTES', '10'); const cancel = vi.fn();
    const stream = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(6)); }, cancel });
    await expect(readEpgBody(new Response(stream))).rejects.toThrow(EpgLimitError); expect(cancel).toHaveBeenCalled();
  });
  it('rejects oversized declared length before reading', async () => {
    vi.stubEnv('EPG_MAX_INPUT_BYTES', '10'); const cancel = vi.fn();
    const stream = new ReadableStream({ cancel });
    await expect(readEpgBody(new Response(stream, { headers: { 'content-length': '11' } }))).rejects.toThrow(EpgLimitError);
    expect(cancel).toHaveBeenCalled();
  });
  it('bounds concurrent processing and releases a slot only once', () => {
    const release = acquireEpgSlot()!; expect(release).toBeTypeOf('function'); expect(acquireEpgSlot()).toBeNull();
    release(); release(); const next = acquireEpgSlot()!; expect(acquireEpgSlot()).toBeNull(); next();
  });
  it('clamps configuration to conservative maxima and rejects invalid values', () => {
    vi.stubEnv('EPG_MAX_CONCURRENCY', '100'); vi.stubEnv('EPG_MAX_INPUT_BYTES', '-1');
    expect(getEpgLimits().concurrency).toBe(2); expect(getEpgLimits().inputBytes).toBe(1024 * 1024);
  });
});

