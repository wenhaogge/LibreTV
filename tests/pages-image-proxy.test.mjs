// Run with: node --test tests/pages-image-proxy.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { onRequest } from '../functions/proxy/[[path]].js';

const jpeg = Uint8Array.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 128, 254, 255, 217]);
const cover = 'https://img3.doubanio.com/view/photo/s_ratio_poster/public/fixture.jpg';

function context(target = cover, env = {}) {
    const pending = [];
    return {
        request: new Request('https://pages.example/proxy/' + encodeURIComponent(target) + '?image-proxy=v2'),
        env,
        waitUntil(promise) { pending.push(promise); },
        pending,
    };
}

function kvFixture(body, contentType) {
    const reads = [];
    const writes = [];
    return {
        reads, writes,
        async get(key) {
            reads.push(key);
            return JSON.stringify({ body, headers: JSON.stringify({ 'content-type': contentType }) });
        },
        async put(...args) { writes.push(args); },
    };
}

test('JPEG bytes survive without UTF-8 replacement, including with a KV binding', async (t) => {
    const kv = kvFixture('corrupted old image', 'image/jpeg');
    t.mock.method(globalThis, 'fetch', async (url) => {
        assert.equal(url, cover, 'cache version must not be appended to upstream URL');
        return new Response(jpeg, { headers: { 'content-type': 'image/jpeg', etag: '"fixture"' } });
    });
    const response = await onRequest(context(cover, { LIBRETV_PROXY_KV: kv }));
    assert.equal(response.status, 200);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), jpeg);
    assert.equal(response.headers.get('content-type'), 'image/jpeg');
    assert.equal(response.headers.get('etag'), '"fixture"');
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal(response.headers.get('cache-control'), 'public, max-age=86400');
    assert.deepEqual(kv.reads, []);
    assert.deepEqual(kv.writes, []);
});

for (const type of ['image/png', 'image/webp', 'image/avif', 'IMAGE/JPEG']) {
    test(`extensionless ${type} bypasses corrupt text cache`, async (t) => {
        const target = 'https://img3.doubanio.com/image?id=1';
        const kv = kvFixture('\uFFFD\uFFFDJFIF', type);
        t.mock.method(globalThis, 'fetch', async () => new Response(jpeg, { headers: { 'content-type': type } }));
        const response = await onRequest(context(target, { LIBRETV_PROXY_KV: kv }));
        assert.deepEqual(new Uint8Array(await response.arrayBuffer()), jpeg);
        assert.deepEqual(kv.reads, ['proxy_raw:' + target]);
        assert.deepEqual(kv.writes, []);
    });
}

test('image URL with query and generic MIME is still transferred as binary', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response(jpeg, { headers: { 'content-type': 'application/octet-stream' } }));
    const response = await onRequest(context(cover + '?token=public-fixture'));
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), jpeg);
});

test('compressed image body and its encoding header remain paired', async (t) => {
    const compressed = gzipSync(jpeg);
    t.mock.method(globalThis, 'fetch', async () => new Response(compressed, {
        headers: { 'content-type': 'image/jpeg', 'content-encoding': 'gzip' },
    }));
    const response = await onRequest(context());
    assert.equal(response.headers.get('content-encoding'), 'gzip');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), compressed);
});

test('image response starts without buffering the complete upstream body', async (t) => {
    let cancelled = false;
    const stream = new ReadableStream({
        start(controller) { controller.enqueue(jpeg); },
        cancel() { cancelled = true; },
    });
    t.mock.method(globalThis, 'fetch', async () => {
        const response = new Response(stream, { headers: { 'content-type': 'image/jpeg' } });
        response.text = () => { throw new Error('binary response must never use text()'); };
        response.arrayBuffer = () => { throw new Error('image must not be buffered'); };
        return response;
    });
    const response = await onRequest(context());
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    assert.deepEqual((await reader.read()).value, jpeg);
    await reader.cancel();
    assert.equal(cancelled, true);
});

test('fresh JSON recommendation response and its text KV cache still work', async (t) => {
    const json = JSON.stringify({ subjects: [{ title: 'Fixture', cover }] });
    const writes = [];
    const kv = { async get() { return null; }, async put(...args) { writes.push(args); } };
    t.mock.method(globalThis, 'fetch', async () => new Response(json, { headers: { 'content-type': 'application/json' } }));
    const ctx = context('https://movie.douban.com/j/search_subjects', { LIBRETV_PROXY_KV: kv });
    const response = await onRequest(ctx);
    await Promise.all(ctx.pending);
    assert.equal(await response.text(), json);
    assert.equal(JSON.parse(writes[0][1]).body, json);
});

test('existing JSON cache is reused without fetching upstream', async (t) => {
    const json = '{"subjects":[]}';
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected upstream request'); });
    const response = await onRequest(context('https://movie.douban.com/j/search_subjects', {
        LIBRETV_PROXY_KV: kvFixture(json, 'application/json'),
    }));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), json);
});

test('HLS media playlists keep rewriting segment, key and map URLs', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response(
        '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST\n',
        { headers: { 'content-type': 'application/vnd.apple.mpegurl' } },
    ));
    const response = await onRequest(context('https://media.example/hls/main.m3u8'));
    const text = await response.text();
    assert.equal(response.status, 200);
    for (const name of ['key.bin', 'init.mp4', 'segment.ts']) {
        assert.ok(text.includes('/proxy/' + encodeURIComponent('https://media.example/hls/' + name)));
    }
    assert.equal(response.headers.get('content-type'), 'application/vnd.apple.mpegurl');
});

test('upstream image errors remain errors and never enter the KV cache', async (t) => {
    const kv = kvFixture('corrupted old image', 'image/jpeg');
    t.mock.method(globalThis, 'fetch', async () => new Response('cdn error', { status: 418, headers: { 'content-type': 'image/jpeg' } }));
    const response = await onRequest(context(cover, { LIBRETV_PROXY_KV: kv }));
    assert.equal(response.status, 500);
    assert.match(await response.text(), /HTTP error 418/);
    assert.deepEqual(kv.writes, []);
});
