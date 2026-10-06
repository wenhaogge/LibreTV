import dns from 'node:dns/promises';
import { isIP } from 'node:net';

/** 去掉 URL.hostname 对 IPv6 附加的方括号（"[::1]" → "::1"） */
function stripBrackets(host: string): string {
  return host.trim().replace(/^\[+|\]+$/g, '');
}

/**
 * IPv4-mapped / IPv4-compatible IPv6 还原为点分十进制，命中不到时返回 null。
 * "::ffff:192.168.1.100" 与 "::ffff:c0a8:164" 都会归一化成 "192.168.1.100"，
 * 否则这类地址会绕过下面的私网规则被当成公网放行。
 */
function toIPv4(ip: string): string | null {
  const v = ip.replace(/^0:0:0:0:0:/i, '::'); // 全写形式
  const dotted = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(v);
  if (dotted) return dotted[1];
  const hex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(v);
  if (!hex) return null;
  const n = (((parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16)) >>> 0);
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** 判断 IP 是否为私有/回环/链路本地/保留地址（SSRF 防护） */
export function isPrivateIP(ip: string): boolean {
  let v = stripBrackets(ip.trim());
  v = toIPv4(v) ?? v;
  const family = isIP(v);
  if (!family) return true; // 无法识别的解析结果不得视为公网。
  if (family === 4) {
    const [a, b, c] = v.split('.').map(Number);
    if (a === 0 || a >= 224 || a === 127 || a === 10) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return true;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
    if (a === 203 && b === 0 && c === 113) return true;
  } else {
    // URL 规范化压缩/全写 IPv6；只接受全球单播，拒绝特殊用途与文档网段。
    v = new URL('http://[' + v + ']/').hostname.slice(1, -1).toLowerCase();
    const first = parseInt(v.split(':')[0], 16);
    if ((first & 0xe000) !== 0x2000 || /^2001:(?:db8|[01]?[0-9a-f]{1,2}):/.test(v) || v.startsWith('3fff:')) return true;
  }
  if (/^(127\.|0\.0\.0\.0$|::1$|::$|fe80:|fc|fd)/i.test(v)) return true;
  if (v.startsWith('10.')) return true;
  if (v.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(v)) return true;
  if (v.startsWith('169.254.')) return true; // 链路本地（含云元数据 169.254.169.254）
  if (v.startsWith('100.64.')) return true; // CGNAT
  if (v.startsWith('192.0.0.')) return true; // 协议分配块
  return false;
}

const BLOCKED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

/** URL 字面量校验：协议白名单 + 主机名/字面量 IP 黑名单 */
export function isValidProxyUrl(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = stripBrackets(parsed.hostname); // "[::1]" 也要能被黑名单命中
    if (BLOCKED_HOSTNAMES.has(host)) return false;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) {
      if (isPrivateIP(host)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * workerd resolve4/resolve6 currently collapse NODATA and other missing-answer
 * responses into ENOTFOUND. Read the DoH status directly to distinguish them.
 * The resolver is fixed, redirects are forbidden, and its body is bounded.
 */
async function resolveWorkersFamily(hostname: string, family: 4 | 6): Promise<string[]> {
  const type = family === 4 ? 1 : 28;
  const query = new URL('https://cloudflare-dns.com/dns-query');
  query.searchParams.set('name', hostname);
  query.searchParams.set('type', family === 4 ? 'A' : 'AAAA');
  const response = await fetch(query, {
    headers: { Accept: 'application/dns-json' },
    redirect: 'manual', signal: AbortSignal.timeout(3000),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error('DNS resolver unavailable');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 65536) throw new Error('DNS response too large');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const data = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  const question = data?.Question?.[0];
  if (data?.Status !== 0 || data.TC !== false || data.Question?.length !== 1 ||
      question?.type !== type || typeof question?.name !== 'string' ||
      question.name.toLowerCase().replace(/\.$/, '') !== hostname.toLowerCase().replace(/\.$/, '')) {
    throw new Error('DNS query failed or returned an unverifiable response');
  }
  // NOERROR without answers is NODATA; NXDOMAIN/SERVFAIL/REFUSED were rejected.
  if (data.Answer === undefined) return [];
  if (!Array.isArray(data.Answer) || data.Answer.length > 64) throw new Error('Invalid DNS answers');
  const addresses: string[] = [];
  for (const answer of data.Answer) {
    if (answer?.type === 5 && typeof answer.data === 'string') continue; // CNAME
    if (answer?.type !== type || typeof answer.data !== 'string' || isIP(answer.data) !== family) {
      throw new Error('Invalid DNS address');
    }
    addresses.push(answer.data);
  }
  return addresses;
}

/** Node ENODATA only means this record family is absent; other errors fail closed. */
async function resolveFamily(hostname: string, family: 4 | 6): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const records = await Promise.race([
      typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers'
        ? resolveWorkersFamily(hostname, family)
        : family === 4 ? dns.resolve4(hostname) : dns.resolve6(hostname),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('DNS query timed out')), 3000);
      }),
    ]);
    if (records.length > 64 || records.some((address) => isIP(address) !== family)) {
      throw new Error('Invalid DNS response');
    }
    return records;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENODATA') return [];
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** DNS 失败、空结果或任一地址无法验证均拒绝；预检查仍无法固定 fetch 的 DNS 结果。 */
export async function isBlockedByDNS(urlString: string): Promise<boolean> {
  try {
    const hostname = stripBrackets(new URL(urlString).hostname);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')) {
      return isPrivateIP(hostname);
    }
    const results = await Promise.allSettled([resolveFamily(hostname, 4), resolveFamily(hostname, 6)]);
    if (results.some((result) => result.status === 'rejected')) return true;
    const addresses = results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
    return addresses.length === 0 || addresses.some(isPrivateIP);
  } catch {
    return true;
  }
}

export type UpstreamVerdict = { ok: true } | { ok: false; reason: string };

/**
 * 出网请求的统一校验入口：字面量校验 + DNS 解析校验。
 *
 * 任何由用户输入驱动的服务端请求（采集站搜索/详情、代理转发）都必须先过这一关，
 * 否则服务器会变成内网探测跳板（/api/search 曾直接用用户传的 source.url 发请求）。
 */
export async function checkUpstreamAllowed(urlString: string): Promise<UpstreamVerdict> {
  if (!isValidProxyUrl(urlString)) {
    return { ok: false, reason: '目标地址不在允许范围内（仅支持公网 http/https）' };
  }
  if (await isBlockedByDNS(urlString)) {
    return { ok: false, reason: '目标地址解析到私有/保留网络，或 DNS 无法安全验证' };
  }
  return { ok: true };
}

/** 直播场景是否放行内网地址（自建 IPTV）；由部署者显式开启 */
export function allowLivePrivate(): boolean {
  return process.env.LIVE_ALLOW_PRIVATE === '1';
}

/**
 * 直播地址专用校验：协议必须 http(s)，默认仍拒绝内网，但部署者可用
 * LIVE_ALLOW_PRIVATE=1 显式放行（自建 IPTV 常位于内网）。
 *
 * 与点播侧 checkUpstreamAllowed 的区别只在这一处开关：
 * 订阅/播放列表若沿用点播那把尺子，会静默过滤掉内网自建源。
 */
export async function checkLiveUrlAllowed(urlString: string): Promise<UpstreamVerdict> {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, reason: '直播地址仅支持 http/https 协议' };
    }
  } catch {
    return { ok: false, reason: '无效的直播地址' };
  }
  if (allowLivePrivate()) return { ok: true };
  return checkUpstreamAllowed(urlString);
}
