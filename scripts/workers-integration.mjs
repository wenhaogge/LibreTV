// Local production-artifact tests: all upstream requests are intercepted. No cloud resources.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, createHmac } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Miniflare } from 'miniflare';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, '.cloudflare/output/v0/workers/default');
const config = JSON.parse(await readFile(path.join(output, 'worker.config.json'), 'utf8'));
const bundle = path.join(output, 'bundle');
const modules = (await readdir(bundle, { recursive: true })).filter(f => f.endsWith('.js'));
modules.sort((a, b) => (a === 'index.js' ? -1 : b === 'index.js' ? 1 : a.localeCompare(b)));
const moduleContents = Object.fromEntries(await Promise.all(modules.map(async f => [f.replaceAll('\\', '/'), { type: 'esm', contents: await readFile(path.join(bundle, f), 'utf8') }])));
const serve = process.argv.includes('--serve');
const PASSWORD = process.env.LOCAL_TEST_PASSWORD || randomBytes(24).toString('hex');
const PROXY_SECRET = process.env.LOCAL_TEST_SECRET || randomBytes(32).toString('hex');
if (serve && (!process.env.LOCAL_TEST_PASSWORD || !process.env.LOCAL_TEST_SECRET)) {
  throw new Error('--serve requires LOCAL_TEST_PASSWORD and LOCAL_TEST_SECRET in the process environment');
}
const upstream = 'https://93.184.216.34';
const source = { key: 'fixture', name: 'Fixture', url: upstream + '/cms' };
const xml = '<tv><programme channel="fixture" start="20000101000000 +0000" stop="20990101000000 +0000"><title>Fixture</title></programme></tv>';
const manifest = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST\n';
let lastRange;
let cancelObserved = false;
let epgStarted;
let releaseEpg;
let bodyLimitCancelled = false;
const calls = [];
const fixture = async (req, res) => {
  const url = new URL(req.headers['mf-original-url'] ?? req.url, 'http://' + req.headers.host);
  calls.push(url.pathname);
  if (url.hostname === 'cloudflare-dns.com' && url.pathname === '/dns-query') {
    const name = url.searchParams.get('name'); const type = url.searchParams.get('type') === 'A' ? 1 : 28;
    const absent = (name === 'a.fixture.test' && type === 28) || (name === 'aaaa.fixture.test' && type === 1);
    const data = { Status: name === 'error.fixture.test' ? 2 : 0, TC: false, Question: [{ name, type }],
      ...(!absent ? { Answer: [{ name, type, TTL: 60, data: type === 1 ? '93.184.216.34' : '2606:4700::1111' }] } : {}) };
    res.setHeader('content-type', 'application/dns-json'); res.end(JSON.stringify(data)); return;
  }
  if (!['93.184.216.34', 'a.fixture.test', 'aaaa.fixture.test', 'both.fixture.test'].includes(url.hostname)) {
    res.writeHead(502).end('Unexpected egress rejected by test harness');
    return;
  }
  if (url.pathname === '/cms') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ pagecount: 1, list: [{ vod_id: 1, vod_name: 'Fixture', vod_play_url: 'Episode$' + upstream + '/media/main.m3u8' }] }));
  } else if (url.pathname === '/sources') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ sources: [source], liveSources: [] }));
  } else if (url.pathname === '/media/main.m3u8') {
    res.setHeader('content-type', 'application/vnd.apple.mpegurl');
    res.end(manifest);
  } else if (url.pathname === '/media/playable.m3u8') {
    res.setHeader('content-type', 'application/vnd.apple.mpegurl');
    res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nplayable.ts\n#EXT-X-ENDLIST\n');
  } else if (url.pathname === '/media/playable.ts') {
    // Use mux.js's bundled caption test fixture; no external media requests.
    res.setHeader('content-type', 'video/mp2t');
    res.end(await readFile(path.join(root, 'node_modules/mux.js/test/segments/multi-channel-608-captions.ts')));
  } else if (url.pathname === '/media/segment.ts') {
    lastRange = req.headers.range;
    res.writeHead(lastRange ? 206 : 200, { 'content-type': 'video/mp2t', 'accept-ranges': 'bytes', ...(lastRange ? { 'content-range': 'bytes 2-5/10' } : {}) });
    res.end(lastRange ? '2345' : '0123456789');
  } else if (url.pathname === '/redirect-private') {
    res.writeHead(302, { location: 'http://127.0.0.1/forbidden' }).end();
  } else if (url.pathname === '/epg' || url.pathname === '/epg.gz') {
    res.end(url.pathname.endsWith('.gz') ? gzipSync(xml) : xml);
  } else if (url.pathname === '/bomb.gz') {
    res.end(gzipSync('x'.repeat(5 * 1024 * 1024)));
  } else if (url.pathname === '/exact-limit.gz') {
    res.end(gzipSync('x'.repeat(4 * 1024 * 1024)));
  } else if (url.pathname === '/malformed.gz') {
    res.end(Buffer.from([31, 139, 1, 2]));
  } else if (url.pathname === '/oversized') {
    res.setHeader('content-length', String(2 * 1024 * 1024));
    res.end('x'.repeat(2 * 1024 * 1024));
  } else if (url.pathname === '/chunked-oversized') {
    const timer = setInterval(() => res.write('x'.repeat(64 * 1024)), 10);
    res.on('close', () => { clearInterval(timer); bodyLimitCancelled = true; });
  } else if (url.pathname === '/epg-slow') {
    epgStarted?.();
    await new Promise(resolve => { releaseEpg = resolve; });
    res.end(xml);
  } else if (url.pathname === '/live.flv') {
    res.writeHead(200, { 'content-type': 'video/x-flv' });
    res.write('FLV'); // Synthetic transport bytes, not a playable media claim.
    const timer = setInterval(() => res.write('fixture-stream-data'), 100);
    res.on('close', () => { clearInterval(timer); cancelObserved = true; });
  } else {
    res.writeHead(404).end('Missing test fixture');
  }
};
const options = (password = PASSWORD, secret = PROXY_SECRET) => ({
  host: '127.0.0.1', port: 0, telemetry: { enabled: false },
  workers: [{
    config: {
      name: 'libretv-local-integration',
      manifest: { mainModule: 'index.js', modulesRoot: bundle, modules: moduleContents },
      compatibilityDate: config.compatibilityDate,
      compatibilityFlags: config.compatibilityFlags,
      env: { PASSWORD: { type: 'text', value: password }, PROXY_SECRET: { type: 'text', value: secret }, ASSETS: { type: 'assets' } },
      assets: { ...config.assets, directory: path.join(output, 'assets'), hasUserWorker: true },
    },
    dev: { outboundService: { type: 'node-handler', handler: fixture } },
  }],
});
let mf;
let base;
let cookie;
let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); }
};
const request = (route, init = {}) => fetch(new URL(route, base), { ...init, headers: { ...(cookie ? { cookie } : {}), ...init.headers } });
const login = async password => {
  const res = await request('/api/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  assert.equal(res.status, 200);
  return res.headers.get('set-cookie');
};
const target = (route, p) => route + '?url=' + encodeURIComponent(upstream + p);
const epg = p => target('/api/live/epg', p) + '&channel=fixture&force=1';
const waitFor = async predicate => {
  const end = Date.now() + 3000;
  while (!predicate() && Date.now() < end) await new Promise(r => setTimeout(r, 50));
  assert.ok(predicate(), 'condition not observed within 3s');
};
try {
  mf = new Miniflare(options());
  base = await mf.ready;
  console.log('Local workerd production artifact started');
  if (serve) {
    console.log('Offline browser fixture server: ' + base.href);
    console.log('Playback path: /watch?source=fixture&sourceUrl=' + encodeURIComponent(source.url) + '&url=' + encodeURIComponent(target('/api/proxy', '/media/playable.m3u8')) + '&title=Local-HLS-fixture');
    await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
    process.exitCode = 0;
  } else {
  await test('home and status', async () => {
    assert.equal((await request('/')).status, 200);
    const status = await (await request('/api/status')).json();
    assert.equal(status.passwordRequired, true); assert.equal(status.verified, false);
  });
  await test('unauthenticated API and wrong password', async () => {
    assert.equal((await request(target('/api/source-list', '/sources'))).status, 401);
    const r = await request('/api/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password":"wrong"}' });
    assert.equal(r.status, 401);
  });
  await test('runtime password, signature and Cookie', async () => {
    const value = await login(PASSWORD);
    assert.match(value, /HttpOnly/i); assert.match(value, /SameSite=lax/i);
    cookie = value.split(';')[0];
    const [expires, sig] = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1)).split('.');
    assert.equal(sig, createHmac('sha256', PROXY_SECRET).update(expires).digest('hex'));
    assert.equal((await (await request('/api/status')).json()).verified, true);
  });
  await test('search JSON', async () => {
    const r = await request('/api/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wd: 'Fixture', sources: [source] }) });
    assert.equal(r.status, 200); const data = await r.json(); assert.equal(data.list.length, 1); assert.equal(data.failures.length, 0);
  });
  await test('search NDJSON', async () => {
    const r = await request('/api/search?stream=1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wd: 'Fixture', sources: [{ ...source, url: source.url + '?fresh=1' }] }) });
    assert.equal(r.status, 200); const text = await r.text(); assert.match(text, /"type":"done"/); assert.match(text, /Fixture/);
  });
  await test('detail and source subscription', async () => {
    const r = await request('/api/detail?id=1&source=' + encodeURIComponent(JSON.stringify(source)));
    assert.equal(r.status, 200); assert.equal((await r.json()).episodes.length, 1);
    const s = await request(target('/api/source-list', '/sources')); assert.equal(s.status, 200); assert.equal((await s.json()).sources.length, 1);
  });
  await test('HLS playlist/key/map rewrite in VOD and live routes', async () => {
    for (const route of ['/api/proxy', '/api/live/stream']) {
      const r = await request(target(route, '/media/main.m3u8')); assert.equal(r.status, 200); const text = await r.text();
      for (const name of ['key.bin', 'init.mp4', 'segment.ts']) assert.ok(text.includes(route + '?url=' + encodeURIComponent(upstream + '/media/' + name)), text);
    }
  });
  await test('segment passthrough and Range', async () => {
    const r = await request(target('/api/proxy', '/media/segment.ts')); assert.equal(await r.text(), '0123456789');
    const range = await request(target('/api/proxy', '/media/segment.ts'), { headers: { range: 'bytes=2-5' } });
    assert.equal(range.status, 206); assert.equal(lastRange, 'bytes=2-5'); assert.equal(range.headers.get('content-range'), 'bytes 2-5/10'); assert.equal(await range.text(), '2345');
  });
  await test('private URL and redirect hop rejected', async () => {
    const count = calls.length;
    assert.equal((await request('/api/live/stream?url=http%3A%2F%2F127.0.0.1%2Fforbidden')).status, 403);
    assert.equal(calls.length, count);
    assert.equal((await request(target('/api/live/stream', '/redirect-private'))).status, 502);
    assert.ok(!calls.includes('/forbidden'));
  });
  await test('Workers DNS: A-only, AAAA-only, dual-stack and SERVFAIL', async () => {
    for (const name of ['a', 'aaaa', 'both']) {
      const r = await request('/api/source-list?url=' + encodeURIComponent('https://' + name + '.fixture.test/sources'));
      assert.equal(r.status, 200, await r.text());
    }
    const r = await request('/api/source-list?url=' + encodeURIComponent('https://error.fixture.test/sources'));
    assert.equal(r.status, 403);
  });
  await test('XMLTV plain and gzip', async () => {
    for (const p of ['/epg', '/epg.gz']) { const r = await request(epg(p)); assert.equal(r.status, 200); assert.equal((await r.json()).programs[0].title, 'Fixture'); }
  });
  await test('XMLTV input limit from headers and streamed bytes', async () => {
    for (const p of ['/oversized', '/chunked-oversized']) { const r = await request(epg(p)); assert.equal(r.status, 413); assert.match((await r.json()).error, /上限/); }
    await waitFor(() => bodyLimitCancelled);
  });
  await test('gzip expansion bounded inside workerd', async () => {
    assert.equal((await request(epg('/exact-limit.gz'))).status, 200);
    const r = await request(epg('/bomb.gz')); const data = await r.json(); assert.equal(r.status, 413, JSON.stringify(data)); assert.match(data.error, /解压/);
    assert.equal((await request(epg('/malformed.gz'))).status, 502);
    assert.equal((await request('/api/status')).status, 200);
  });
  await test('EPG concurrency rejection and slot recovery', async () => {
    const started = new Promise(r => { epgStarted = r; }); const slow = request(epg('/epg-slow'));
    await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error('fixture start timeout')), 5000))]);
    try { assert.equal((await request(epg('/epg'))).status, 503); } finally { releaseEpg(); }
    assert.equal((await slow).status, 200);
    assert.equal((await request(epg('/epg'))).status, 200);
  });
  await test('live stream lasts over 8s and disconnect cancels upstream', async () => {
    const controller = new AbortController();
    const r = await request(target('/api/live/stream', '/live.flv'), { signal: controller.signal });
    assert.equal(r.status, 200); const reader = r.body.getReader(); let bytes = 0;
    const end = Date.now() + 8500;
    try { while (Date.now() < end) { const chunk = await reader.read(); assert.equal(chunk.done, false); bytes += chunk.value.byteLength; } }
    finally { controller.abort(); await reader.cancel().catch(() => {}); }
    assert.ok(bytes > 100); await waitFor(() => cancelObserved);
  });
  await test('runtime rotation without rebuild invalidates old session', async () => {
    const newPassword = randomBytes(24).toString('hex'); const newSecret = randomBytes(32).toString('hex');
    await mf.setOptions(options(newPassword, newSecret)); base = await mf.ready;
    assert.equal((await (await request('/api/status')).json()).verified, false);
    const old = await request('/api/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) }); assert.equal(old.status, 401);
    cookie = (await login(newPassword)).split(';')[0];
    assert.equal((await (await request('/api/status')).json()).verified, true);
  });
  }
} finally {
  await mf?.dispose();
}
console.log(serve ? 'Offline browser fixture server stopped' : JSON.stringify({ passed, failed, browserPlayback: 'not tested by this command; synthetic stream bytes only' }));
if (failed) process.exitCode = 1;
