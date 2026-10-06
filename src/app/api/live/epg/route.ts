import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { checkLiveUrlAllowed } from '@/lib/ssrf';
import { fetchUpstream } from '@/lib/fetch-utils';
import { getLiveCache, setLiveCache } from '@/lib/live-cache';
import { currentAndNext, estimateXmltvBytes, parseXmltv } from '@/lib/xmltv';
import { acquireEpgSlot, EpgLimitError, readEpgBody } from '@/lib/epg-limits';
import type { EpgProgram } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** XMLTV 文件较大，放宽抓取超时 */
const FETCH_TIMEOUT_MS = 30_000;
const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * 拉取并解析 XMLTV 节目单（支持 gzip）。
 * GET /api/live/epg?url=<xmltv>&channel=<tvgId>&force=1
 * 解析结果（按频道索引、24h 时间窗裁剪）整体缓存 6 小时；单频道按需查询。
 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const sp = new URL(req.url).searchParams;
  const url = sp.get('url')?.trim();
  const channel = sp.get('channel')?.trim();
  if (!url || !channel) return jsonError('缺少 url 或 channel 参数', 400);
  const force = sp.get('force') === '1';

  // 直播专用校验 + allowPrivate：与 playlist/stream/probe 同一把尺子，
  // LIVE_ALLOW_PRIVATE=1 时内网自建 IPTV 的 XMLTV 节目单才能拉取
  const verdict = await checkLiveUrlAllowed(url);
  if (!verdict.ok) return jsonError(verdict.reason, 403);

  const key = `live:epg:${url}`;
  let programMap: Map<string, EpgProgram[]> | undefined = force ? undefined : getLiveCache(key);
  if (!programMap) {
    const release = acquireEpgSlot();
    if (!release) return jsonError('节目单处理繁忙，已达到并发上限，请稍后重试', 503);
    try {
      const res = await fetchUpstream(url, { timeoutMs: FETCH_TIMEOUT_MS, retries: 0, allowPrivate: true });
      if (!res.ok) {
        await res.body?.cancel();
        return jsonError(`节目单地址请求失败: ${res.status}`, 502);
      }
      // gzip 由 parseXmltv 内识别（fetch 对 .gz 不会自动解压）
      const buf = await readEpgBody(res);
      programMap = parseXmltv(buf, WINDOW_MS);
      setLiveCache(key, programMap, CACHE_TTL_MS, estimateXmltvBytes(programMap));
    } catch (err) {
      if (err instanceof EpgLimitError) return jsonError(err.message, 413);
      return jsonError(`节目单地址请求失败: ${err instanceof Error ? err.message : '未知错误'}`, 502);
    } finally {
      release();
    }
  }

  const programs = programMap.get(channel) ?? [];
  const { current, next } = currentAndNext(programs);

  return NextResponse.json(
    { channelId: channel, current, next, programs },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
