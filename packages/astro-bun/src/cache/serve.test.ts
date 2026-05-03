import { describe, expect, mock, test } from 'bun:test';
import { buildImageCacheKey } from './images.ts';
import { __test__, createCacheServer } from './serve.ts';
import type { Clock, FileSystem, StoreDeps } from './store.ts';

// ═════════════════════════════════════════════════════════════════════════
// Test helpers (fake clock + fake fs, same shape as store.test.ts)
// ═════════════════════════════════════════════════════════════════════════

function createFakeFileSystem(): FileSystem {
  const files = new Map<string, string>();
  return {
    async read(path) {
      return files.get(path);
    },
    async write(path, data) {
      files.set(path, data);
    },
    async remove(path) {
      files.delete(path);
    },
    async exists(path) {
      return files.has(path);
    },
    async mkdir() {},
    async removeDir(path) {
      const prefix = path.endsWith('/') ? path : `${path}/`;
      for (const f of [...files.keys()]) {
        if (f === path || f.startsWith(prefix)) files.delete(f);
      }
    },
  };
}

type FakeClock = Clock & {
  setNow: (ms: number) => void;
  advance: (ms: number) => void;
};

function createFakeClock(initialNow = 1_000_000): FakeClock {
  let now = initialNow;
  type T = { dueAt: number; fn: () => void; cleared: boolean };
  const timers: T[] = [];
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const t: T = { dueAt: now + ms, fn, cleared: false };
      timers.push(t);
      return {
        clear() {
          t.cleared = true;
        },
      };
    },
    setNow(ms) {
      now = ms;
    },
    advance(ms) {
      const target = now + ms;
      while (true) {
        const due = timers
          .filter((t) => !t.cleared && t.dueAt <= target)
          .sort((a, b) => a.dueAt - b.dueAt)[0];
        if (!due) break;
        now = due.dueAt;
        due.cleared = true;
        due.fn();
      }
      now = target;
    },
  };
}

function fakeDeps(initialNow?: number): StoreDeps & { clock: FakeClock } {
  return {
    fs: createFakeFileSystem(),
    clock: createFakeClock(initialNow),
    hash: (k) => `h_${k}`,
  };
}

const BUILD_ID = 'b1';
const CACHE_DIR = '/cache';
const IMAGE_ROUTE = '/_image';

function req(path: string) {
  return new Request(`http://localhost${path}`);
}

function makeOrigin(
  headers: Record<string, string> = {},
  body = 'ok',
  status = 200,
) {
  return mock(async (_request: Request) => {
    return new Response(body, { status, headers });
  });
}

function makeServer(
  origin: (r: Request) => Promise<Response>,
  deps = fakeDeps(),
) {
  return {
    server: createCacheServer(
      {
        origin,
        maxByteSize: 1024 * 1024,
        cacheDir: CACHE_DIR,
        buildId: BUILD_ID,
        warmOnInit: false,
        imageEndpointRoute: IMAGE_ROUTE,
      },
      deps,
    ),
    deps,
  };
}

describe('Cache', () => {
  describe('parseDirective', () => {
    test('extracts s-maxage from compound header', () => {
      expect(__test__.parseDirective('public, s-maxage=60', 's-maxage')).toBe(
        60,
      );
    });

    test('extracts stale-while-revalidate', () => {
      expect(
        __test__.parseDirective(
          's-maxage=60, stale-while-revalidate=300',
          'stale-while-revalidate',
        ),
      ).toBe(300);
    });

    test('case-insensitive', () => {
      expect(__test__.parseDirective('S-MAXAGE=42', 's-maxage')).toBe(42);
    });

    test('returns undefined when directive absent', () => {
      expect(
        __test__.parseDirective('public, max-age=60', 's-maxage'),
      ).toBeUndefined();
    });

    test('handles whitespace around equals', () => {
      expect(__test__.parseDirective('s-maxage = 60', 's-maxage')).toBe(60);
    });

    test('returns undefined for empty header', () => {
      expect(__test__.parseDirective('', 's-maxage')).toBeUndefined();
    });
  });

  describe('extractCacheableEntry', () => {
    test('returns entry when s-maxage present', () => {
      const entry = __test__.extractCacheableEntry(
        [['cache-control', 's-maxage=60']],
        200,
        new Uint8Array([1, 2]),
        12345,
      );
      expect(entry).toBeDefined();
      expect(entry?.sMaxAge).toBe(60);
      expect(entry?.swr).toBe(0);
      expect(entry?.cachedAt).toBe(12345);
      expect(entry?.status).toBe(200);
    });

    test('captures stale-while-revalidate', () => {
      const entry = __test__.extractCacheableEntry(
        [['cache-control', 's-maxage=60, stale-while-revalidate=120']],
        200,
        new Uint8Array(),
        0,
      );
      expect(entry?.swr).toBe(120);
    });

    test('returns undefined without s-maxage', () => {
      const entry = __test__.extractCacheableEntry(
        [['cache-control', 'max-age=60']],
        200,
        new Uint8Array(),
        0,
      );
      expect(entry).toBeUndefined();
    });

    test('returns undefined when s-maxage=0', () => {
      const entry = __test__.extractCacheableEntry(
        [['cache-control', 's-maxage=0']],
        200,
        new Uint8Array(),
        0,
      );
      expect(entry).toBeUndefined();
    });

    test('returns undefined when no cache-control header at all', () => {
      const entry = __test__.extractCacheableEntry(
        [['content-type', 'text/html']],
        200,
        new Uint8Array(),
        0,
      );
      expect(entry).toBeUndefined();
    });
  });

  describe('Image Endpoint Helpers', () => {
    describe('isImageEndpointKey', () => {
      test('exact route matches', () => {
        expect(__test__.isImageEndpointKey('/_image', '/_image')).toBe(true);
      });

      test('route with query string matches', () => {
        expect(
          __test__.isImageEndpointKey('/_image?href=foo.png', '/_image'),
        ).toBe(true);
      });

      test('different route does not match', () => {
        expect(__test__.isImageEndpointKey('/page', '/_image')).toBe(false);
      });

      test('route prefix without ? does not match', () => {
        expect(__test__.isImageEndpointKey('/_imagery', '/_image')).toBe(false);
      });
    });

    describe('overrideImageCacheControl', () => {
      test('replaces existing cache-control header in place', () => {
        const headers: [string, string][] = [
          ['content-type', 'image/png'],
          ['cache-control', 'public, max-age=31536000'],
        ];
        __test__.overrideImageCacheControl(headers);
        expect(headers[1]?.[1]).toContain('s-maxage=31536000');
        expect(headers[1]?.[1]).toContain('stale-while-revalidate');
      });

      test('no-op when cache-control header absent', () => {
        const headers: [string, string][] = [['content-type', 'image/png']];
        __test__.overrideImageCacheControl(headers);
        expect(headers).toEqual([['content-type', 'image/png']]);
      });
    });

    describe('buildImageCacheKey', () => {
      test('returns pathname unchanged when no params are present', () => {
        const params = new URLSearchParams();
        expect(buildImageCacheKey('/_image', params)).toBe('/_image');
      });

      test('returns pathname unchanged when no recognized params are present', () => {
        const params = new URLSearchParams('utm_source=newsletter&fbclid=123');
        expect(buildImageCacheKey('/_image', params)).toBe('/_image');
      });

      test('includes only the recognized params that are actually set', () => {
        const params = new URLSearchParams('href=foo.png&w=200&q=80');
        const key = buildImageCacheKey('/_image', params);
        expect(key).toBe('/_image?href=foo.png&q=80&w=200');
      });

      test('strips unrecognized params while keeping recognized ones', () => {
        const params = new URLSearchParams(
          'href=foo.png&w=200&utm_source=newsletter&fbclid=123',
        );
        const key = buildImageCacheKey('/_image', params);
        expect(key).toBe('/_image?href=foo.png&w=200');
      });

      test('produces identical keys regardless of input param order', () => {
        const a = new URLSearchParams('w=200&href=foo.png&q=80');
        const b = new URLSearchParams('q=80&href=foo.png&w=200');
        expect(buildImageCacheKey('/_image', a)).toBe(
          buildImageCacheKey('/_image', b),
        );
      });

      test('treats different param values as different keys', () => {
        const a = new URLSearchParams('href=foo.png&w=200');
        const b = new URLSearchParams('href=foo.png&w=400');
        expect(buildImageCacheKey('/_image', a)).not.toBe(
          buildImageCacheKey('/_image', b),
        );
      });

      test('captures all supported image params when set', () => {
        const params = new URLSearchParams({
          background: '#fff',
          f: 'webp',
          fit: 'cover',
          h: '100',
          href: 'foo.png',
          position: 'center',
          q: '80',
          w: '200',
        });
        const key = buildImageCacheKey('/_image', params);
        expect(key).toContain('background=%23fff');
        expect(key).toContain('f=webp');
        expect(key).toContain('fit=cover');
        expect(key).toContain('h=100');
        expect(key).toContain('href=foo.png');
        expect(key).toContain('position=center');
        expect(key).toContain('q=80');
        expect(key).toContain('w=200');
      });

      test('uses the provided pathname unchanged in the key', () => {
        const params = new URLSearchParams('href=foo.png');
        expect(buildImageCacheKey('/custom-route', params)).toBe(
          '/custom-route?href=foo.png',
        );
      });

      test('preserves empty string values when params are explicitly set to empty', () => {
        const params = new URLSearchParams('href=foo.png&w=');
        const key = buildImageCacheKey('/_image', params);
        expect(key).toBe('/_image?href=foo.png&w=');
      });
    });
  });

  describe('classifyEntry', () => {
    const baseEntry = {
      body: new Uint8Array(),
      headers: [],
      status: 200,
      cachedAt: 1000,
      sMaxAge: 60,
      swr: 30,
    };

    test('miss when entry undefined', () => {
      expect(__test__.classifyEntry(undefined, 0)).toEqual({ status: 'miss' });
    });

    test('hit when within s-maxage window', () => {
      const decision = __test__.classifyEntry(baseEntry, 1000 + 30_000);
      expect(decision.status).toBe('hit');
    });

    test('hit at exact cachedAt', () => {
      const decision = __test__.classifyEntry(baseEntry, 1000);
      expect(decision.status).toBe('hit');
    });

    test('stale when past s-maxage but within SWR', () => {
      // 60s fresh, 30s swr → stale at 61s, expired at 91s
      const decision = __test__.classifyEntry(baseEntry, 1000 + 61_000);
      expect(decision.status).toBe('stale');
    });

    test('expired when beyond s-maxage + swr', () => {
      const decision = __test__.classifyEntry(baseEntry, 1000 + 100_000);
      expect(decision.status).toBe('expired');
    });

    test('expired when swr is 0 and past s-maxage', () => {
      const noSwr = { ...baseEntry, swr: 0 };
      const decision = __test__.classifyEntry(noSwr, 1000 + 61_000);
      expect(decision.status).toBe('expired');
    });
  });

  describe('responseFromEntry', () => {
    test('reconstructs response with cache header', async () => {
      const res = __test__.responseFromEntry(
        {
          body: new Uint8Array([104, 105]), // "hi"
          headers: [['content-type', 'text/plain']],
          status: 201,
          cachedAt: 0,
          sMaxAge: 60,
          swr: 0,
        },
        'HIT',
      );
      expect(res.status).toBe(201);
      expect(res.headers.get('content-type')).toBe('text/plain');
      expect(res.headers.get('x-astro-cache')).toBe('HIT');
      expect(await res.text()).toBe('hi');
    });
  });

  describe('Server > Basic Flow', () => {
    test('cache miss — calls origin, returns SSR response', async () => {
      const origin = makeOrigin();
      const { server } = makeServer(origin);
      const res = await server(req('/page'), '/page');
      expect(origin).toHaveBeenCalledTimes(1);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-astro-cache')).toBe('MISS');
      expect(await res.text()).toBe('ok');
    });

    test('fresh hit — second request served from cache', async () => {
      const origin = makeOrigin({ 'cache-control': 's-maxage=60' }, 'cached');
      const { server } = makeServer(origin);
      const first = await server(req('/page'), '/page');
      await first.text(); // drain → entry populated

      const second = await server(req('/page'), '/page');
      expect(origin).toHaveBeenCalledTimes(1);
      expect(second.headers.get('x-astro-cache')).toBe('HIT');
      expect(await second.text()).toBe('cached');
    });

    test('non-cacheable response (no s-maxage) — never cached', async () => {
      const origin = makeOrigin({ 'cache-control': 'max-age=60' }, 'nope');
      const { server } = makeServer(origin);
      await (await server(req('/page'), '/page')).text();
      await (await server(req('/page'), '/page')).text();
      expect(origin).toHaveBeenCalledTimes(2);
    });

    test('s-maxage=0 — not cached', async () => {
      const origin = makeOrigin({ 'cache-control': 's-maxage=0' }, 'zero');
      const { server } = makeServer(origin);
      await (await server(req('/page'), '/page')).text();
      await (await server(req('/page'), '/page')).text();
      expect(origin).toHaveBeenCalledTimes(2);
    });
  });

  describe('Server > Stale-While-Revalidate', () => {
    test('serves stale + triggers background revalidation', async () => {
      let n = 0;
      const origin = mock(async (_r: Request) => {
        n++;
        return new Response(`v${n}`, {
          status: 200,
          headers: {
            'cache-control': 's-maxage=60, stale-while-revalidate=600',
          },
        });
      });
      const deps = fakeDeps(1_000_000);
      const { server } = makeServer(origin, deps);

      await (await server(req('/page'), '/page')).text();
      expect(origin).toHaveBeenCalledTimes(1);

      // Move into SWR window: past s-maxage (60s) but within swr (600s)
      deps.clock.advance(61_000);

      const stale = await server(req('/page'), '/page');
      expect(stale.headers.get('x-astro-cache')).toBe('STALE');
      expect(await stale.text()).toBe('v1');
      expect(origin).toHaveBeenCalledTimes(2); // background fired

      // Allow microtasks to settle so revalidation finishes writing.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // Subsequent request: cached entry was rewritten with cachedAt=now,
      // so it's a fresh HIT.
      const fresh = await server(req('/page'), '/page');
      expect(fresh.headers.get('x-astro-cache')).toBe('HIT');
      expect(await fresh.text()).toBe('v2');
      expect(origin).toHaveBeenCalledTimes(2);
    });

    test('concurrent stale requests deduplicate revalidation', async () => {
      let n = 0;
      const origin = mock(async (_r: Request) => {
        n++;
        return new Response(`v${n}`, {
          status: 200,
          headers: {
            'cache-control': 's-maxage=60, stale-while-revalidate=600',
          },
        });
      });
      const deps = fakeDeps(1_000_000);
      const { server } = makeServer(origin, deps);

      await (await server(req('/page'), '/page')).text();
      deps.clock.advance(61_000);

      await Promise.all([
        server(req('/page'), '/page').then((r) => r.text()),
        server(req('/page'), '/page').then((r) => r.text()),
        server(req('/page'), '/page').then((r) => r.text()),
      ]);

      // 1 initial + 1 background revalidation.
      expect(origin).toHaveBeenCalledTimes(2);
    });

    test('expired beyond SWR — full re-render and replaces entry', async () => {
      let n = 0;
      const origin = mock(async (_r: Request) => {
        n++;
        return new Response(`v${n}`, {
          status: 200,
          headers: {
            'cache-control': 's-maxage=60, stale-while-revalidate=30',
          },
        });
      });
      const deps = fakeDeps(1_000_000);
      const { server } = makeServer(origin, deps);

      await (await server(req('/page'), '/page')).text();
      deps.clock.advance(91_000); // past s-maxage(60) + swr(30) = 90s

      const res = await server(req('/page'), '/page');
      expect(res.headers.get('x-astro-cache')).toBe('MISS');
      expect(await res.text()).toBe('v2');
      expect(origin).toHaveBeenCalledTimes(2);
    });

    test('background revalidation rejection is swallowed', async () => {
      let n = 0;
      const origin = mock((_r: Request) => {
        n++;
        // First call (initial populate) succeeds; second (revalidation) rejects.
        if (n === 2) return Promise.reject(new Error('revalidation boom'));
        return Promise.resolve(
          new Response('v1', {
            status: 200,
            headers: {
              'cache-control': 's-maxage=60, stale-while-revalidate=600',
            },
          }),
        );
      });
      const deps = fakeDeps(1_000_000);
      const { server } = makeServer(origin, deps);

      await (await server(req('/page'), '/page')).text();
      deps.clock.advance(61_000); // into SWR window

      // Should not throw despite the failing revalidation
      const stale = await server(req('/page'), '/page');
      expect(stale.headers.get('x-astro-cache')).toBe('STALE');
      expect(await stale.text()).toBe('v1');

      // Allow the rejection to surface and the .catch to swallow it.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // The cached entry is still serveable as stale (revalidation failed silently).
      const stillStale = await server(req('/page'), '/page');
      expect(stillStale.headers.get('x-astro-cache')).toBe('STALE');
    });
  });

  describe('Server > Concurrent Request Coalescing', () => {
    test('concurrent miss for same key — one origin call, both get response', async () => {
      let n = 0;
      const origin = mock(async (_r: Request) => {
        n++;
        return new Response(`v${n}`, {
          status: 200,
          headers: { 'cache-control': 's-maxage=60' },
        });
      });
      const { server } = makeServer(origin);

      const [a, b] = await Promise.all([
        server(req('/page'), '/page'),
        server(req('/page'), '/page'),
      ]);

      expect(origin).toHaveBeenCalledTimes(1);
      expect(await a.text()).toBe('v1');
      expect(await b.text()).toBe('v1');
    });

    test('concurrent miss for non-cacheable — second falls back to BYPASS', async () => {
      let n = 0;
      const origin = mock(async (_r: Request) => {
        n++;
        // small delay so both gets land before first response is processed
        await new Promise((r) => setImmediate(r));
        return new Response(`v${n}`, {
          status: 200,
          headers: { 'cache-control': 'max-age=60' },
        });
      });
      const { server } = makeServer(origin);

      const [a, b] = await Promise.all([
        server(req('/page'), '/page'),
        server(req('/page'), '/page'),
      ]);

      const aText = await a.text();
      const bText = await b.text();
      expect(aText).toMatch(/v\d/);
      expect(bText).toMatch(/v\d/);
      // Second caller waits for first then sees not-cacheable result → BYPASS.
      const statuses = [
        a.headers.get('x-astro-cache'),
        b.headers.get('x-astro-cache'),
      ];
      expect(statuses).toContain('MISS');
      expect(statuses).toContain('BYPASS');
      expect(origin).toHaveBeenCalledTimes(2);
    });
  });

  describe('Server > Image Endpoint', () => {
    test('image with only max-age gets overridden and cached', async () => {
      const origin = makeOrigin(
        { 'cache-control': 'public, max-age=31536000' },
        'png-bytes',
      );
      const { server } = makeServer(origin);
      const key = '/_image?href=foo.png&w=100';

      await (await server(req(key), key)).text();
      const second = await server(req(key), key);
      expect(origin).toHaveBeenCalledTimes(1);
      expect(second.headers.get('x-astro-cache')).toBe('HIT');
      expect(await second.text()).toBe('png-bytes');
    });

    test('non-image with only max-age does NOT get override', async () => {
      const origin = makeOrigin(
        { 'cache-control': 'public, max-age=31536000' },
        'page',
      );
      const { server } = makeServer(origin);
      await (await server(req('/page'), '/page')).text();
      await (await server(req('/page'), '/page')).text();
      expect(origin).toHaveBeenCalledTimes(2);
    });

    test('image without any cache-control header — override loop runs but skips', async () => {
      const origin = makeOrigin({}, 'png');
      const { server } = makeServer(origin);
      const key = '/_image?href=foo.png';
      const res = await server(req(key), key);
      await res.text();
      // Not cacheable (no s-maxage, no cache-control at all)
      expect(origin).toHaveBeenCalledTimes(1);
    });

    test('different image query strings produce separate entries', async () => {
      let n = 0;
      const origin = mock(async (_r: Request) => {
        n++;
        return new Response(`img-${n}`, {
          status: 200,
          headers: { 'cache-control': 'public, max-age=31536000' },
        });
      });
      const { server } = makeServer(origin);

      const k1 = '/_image?href=a.png&w=100';
      const k2 = '/_image?href=b.png&w=200';
      await (await server(req(k1), k1)).text();
      await (await server(req(k2), k2)).text();
      expect(origin).toHaveBeenCalledTimes(2);

      const h1 = await server(req(k1), k1);
      const h2 = await server(req(k2), k2);
      expect(h1.headers.get('x-astro-cache')).toBe('HIT');
      expect(h2.headers.get('x-astro-cache')).toBe('HIT');
      expect(await h1.text()).toBe('img-1');
      expect(await h2.text()).toBe('img-2');
      expect(origin).toHaveBeenCalledTimes(2);
    });
  });

  describe('Server > Control Surface', () => {
    test('expire(key) removes single entry', async () => {
      const origin = makeOrigin({ 'cache-control': 's-maxage=60' }, 'page');
      const { server } = makeServer(origin);
      await (await server(req('/page'), '/page')).text();
      expect(
        (await server(req('/page'), '/page')).headers.get('x-astro-cache'),
      ).toBe('HIT');

      await server.cache.expire('/page');
      const after = await server(req('/page'), '/page');
      expect(after.headers.get('x-astro-cache')).toBe('MISS');
    });

    test('expireAll clears page entries but preserves image cache', async () => {
      const origin = mock(async (r: Request) => {
        const url = new URL(r.url);
        if (url.pathname === IMAGE_ROUTE) {
          return new Response('img', {
            status: 200,
            headers: { 'cache-control': 'public, max-age=31536000' },
          });
        }
        return new Response('page', {
          status: 200,
          headers: { 'cache-control': 's-maxage=60' },
        });
      });
      const { server } = makeServer(origin);

      const imgKey = '/_image?href=x.png';
      await (await server(req('/page'), '/page')).text();
      await (await server(req(imgKey), imgKey)).text();

      await server.cache.expireAll();

      expect(
        (await server(req('/page'), '/page')).headers.get('x-astro-cache'),
      ).toBe('MISS');
      expect(
        (await server(req(imgKey), imgKey)).headers.get('x-astro-cache'),
      ).toBe('HIT');
    });

    test('shutdown calls store.save', async () => {
      const origin = makeOrigin({ 'cache-control': 's-maxage=60' }, 'page');
      const { server, deps } = makeServer(origin);
      await (await server(req('/page'), '/page')).text();
      await server.shutdown();
      // After shutdown the index file should exist in the fake fs.
      const indexPath = `${CACHE_DIR}/${BUILD_ID}/index.json`;
      expect(await deps.fs.read(indexPath)).toBeDefined();
    });
  });
});
