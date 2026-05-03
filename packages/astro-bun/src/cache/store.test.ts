import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CacheEntry } from '../types.ts';
import {
  __test__,
  type Clock,
  createCacheStore,
  defaultDeps,
  type FileSystem,
  type StoreDeps,
} from './store.ts';

// ═════════════════════════════════════════════════════════════════════════
// Test helpers
// ═════════════════════════════════════════════════════════════════════════

type FakeFileSystem = FileSystem & {
  files: Map<string, string>;
  failOnce: (op: 'read' | 'write' | 'remove' | 'mkdir', match?: string) => void;
};

function createFakeFileSystem(): FakeFileSystem {
  const files = new Map<string, string>();
  const failures: { op: string; match?: string }[] = [];

  const checkFail = (op: string, path: string) => {
    const idx = failures.findIndex(
      (f) => f.op === op && (f.match === undefined || path.includes(f.match)),
    );
    if (idx >= 0) {
      failures.splice(idx, 1);
      throw new Error(`fake ${op} failure on ${path}`);
    }
  };

  return {
    files,
    failOnce(op, match) {
      failures.push({ op, match });
    },
    async read(path) {
      checkFail('read', path);
      return files.get(path);
    },
    async write(path, data) {
      checkFail('write', path);
      files.set(path, data);
    },
    async remove(path) {
      checkFail('remove', path);
      files.delete(path);
    },
    async exists(path) {
      return files.has(path);
    },
    async mkdir(path) {
      checkFail('mkdir', path);
    },
    async removeDir(path) {
      const prefix = path.endsWith('/') ? path : `${path}/`;
      for (const f of [...files.keys()]) {
        if (f === path || f.startsWith(prefix)) files.delete(f);
      }
    },
  };
}

type FakeClock = Clock & {
  advance: (ms: number) => void;
  pendingTimers: () => number;
};

type FakeTimer = { dueAt: number; fn: () => void; cleared: boolean };

function createFakeClock(initialNow = 1_000_000): FakeClock {
  let now = initialNow;
  const timers: FakeTimer[] = [];

  return {
    now: () => now,
    setTimeout(fn, ms) {
      const timer: FakeTimer = { dueAt: now + ms, fn, cleared: false };
      timers.push(timer);
      return {
        clear() {
          timer.cleared = true;
        },
      };
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
    pendingTimers() {
      return timers.filter((t) => !t.cleared).length;
    },
  };
}

type FakeDeps = StoreDeps & { fs: FakeFileSystem; clock: FakeClock };

function fakeDeps(initialNow?: number): FakeDeps {
  return {
    fs: createFakeFileSystem(),
    clock: createFakeClock(initialNow),
    hash: (k) => `h_${k}`,
  };
}

const BUILD_ID = 'b1';
const CACHE_DIR = '/cache';

function entry(size: number, overrides: Partial<CacheEntry> = {}): CacheEntry {
  return {
    body: new Uint8Array(size),
    headers: [],
    status: 200,
    cachedAt: 0,
    sMaxAge: 60,
    swr: 0,
    ...overrides,
  };
}

function tmpDir() {
  return join(
    tmpdir(),
    `store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

describe('Cache', () => {
  describe('List Operations', () => {
    test('createListSentinel — self-referential', () => {
      const s = __test__.createListSentinel();
      expect(s.older).toBe(s);
      expect(s.newer).toBe(s);
    });

    test('listInsertFront / listDetach / listMoveToFront', () => {
      const head = __test__.createListSentinel();
      const tail = __test__.createListSentinel();
      head.newer = tail;
      tail.older = head;

      const a = __test__.createListEntry('a', entry(1), 1);
      const b = __test__.createListEntry('b', entry(1), 1);
      const c = __test__.createListEntry('c', entry(1), 1);

      // Use a helper that erases the union narrowing — we just want pointer equality.
      const same = (x: unknown, y: unknown) => Object.is(x, y);

      __test__.listInsertFront(head, a);
      __test__.listInsertFront(head, b);
      __test__.listInsertFront(head, c);
      // Order from head: c, b, a, tail
      expect(same(head.newer, c)).toBe(true);
      expect(same(c.newer, b)).toBe(true);
      expect(same(b.newer, a)).toBe(true);
      expect(same(a.newer, tail)).toBe(true);

      __test__.listMoveToFront(head, a);
      expect(same(head.newer, a)).toBe(true);
      expect(same(a.newer, c)).toBe(true);

      __test__.listDetach(b);
      expect(same(c.newer, tail)).toBe(true);
      expect(same(tail.older, c)).toBe(true);
    });
  });

  describe('Serialization', () => {
    test('encodeEntry / decodeEntry roundtrip', () => {
      const original: CacheEntry = {
        body: new Uint8Array([1, 2, 3, 255]),
        headers: [['x-test', 'value']],
        status: 200,
        cachedAt: 12345,
        sMaxAge: 60,
        swr: 30,
      };
      const decoded = __test__.decodeEntry(__test__.encodeEntry(original));
      expect(decoded.body).toEqual(original.body);
      expect(decoded.headers).toEqual(original.headers);
      expect(decoded.status).toBe(original.status);
      expect(decoded.cachedAt).toBe(original.cachedAt);
      expect(decoded.sMaxAge).toBe(original.sMaxAge);
      expect(decoded.swr).toBe(original.swr);
    });
  });

  describe('Store > Basic Operations', () => {
    test('get/set/get round-trip', async () => {
      const store = createCacheStore(
        {
          maxByteSize: 1024,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: false,
        },
        fakeDeps(),
      );
      await store.set('a', entry(100));
      const result = await store.get('a');
      expect(result?.body.byteLength).toBe(100);
      await store.destroy();
    });

    test('get on missing key returns undefined', async () => {
      const store = createCacheStore(
        {
          maxByteSize: 1024,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: false,
        },
        fakeDeps(),
      );
      expect(await store.get('missing')).toBeUndefined();
      await store.destroy();
    });

    test('delete removes from memory and disk', async () => {
      const deps = fakeDeps();
      const store = createCacheStore(
        {
          maxByteSize: 1024,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: false,
        },
        deps,
      );
      await store.set('a', entry(100));
      expect(
        deps.fs.files.has(`${CACHE_DIR}/${BUILD_ID}/entries/h_a.json`),
      ).toBe(true);
      await store.delete('a');
      expect(
        deps.fs.files.has(`${CACHE_DIR}/${BUILD_ID}/entries/h_a.json`),
      ).toBe(false);
      expect(await store.get('a')).toBeUndefined();
      await store.destroy();
    });

    test('delete on missing key is a no-op', async () => {
      const store = createCacheStore(
        {
          maxByteSize: 1024,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: false,
        },
        fakeDeps(),
      );
      await store.delete('never-set');
      await store.destroy();
    });

    test('keys getter exposes persisted keys', async () => {
      const store = createCacheStore(
        {
          maxByteSize: 1024,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: false,
        },
        fakeDeps(),
      );
      await store.set('a', entry(50));
      await store.set('b', entry(50));
      expect(store.keys.has('a')).toBe(true);
      expect(store.keys.has('b')).toBe(true);
      expect(store.keys.size).toBe(2);
      await store.destroy();
    });

    test('set with size > maxByteSize is rejected silently', async () => {
      const store = createCacheStore(
        {
          maxByteSize: 100,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: false,
        },
        fakeDeps(),
      );
      await store.set('huge', entry(200));
      expect(await store.get('huge')).toBeUndefined();
      expect(store.keys.has('huge')).toBe(false);
      await store.destroy();
    });

    test('set updates existing entry size correctly', async () => {
      const store = createCacheStore(
        {
          maxByteSize: 200,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: false,
        },
        fakeDeps(),
      );
      await store.set('a', entry(100));
      await store.set('a', entry(150)); // overwrite
      await store.set('b', entry(50));
      // Total = 150 + 50 = 200, both fit
      expect(await store.get('a')).toBeDefined();
      expect(await store.get('b')).toBeDefined();
      await store.destroy();
    });
  });

  describe('Store > LRU Eviction', () => {
    test('evicts oldest when over budget, keeps on disk', async () => {
      const deps = fakeDeps();
      const store = createCacheStore(
        {
          maxByteSize: 200,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: false,
        },
        deps,
      );
      await store.set('a', entry(100));
      await store.set('b', entry(100));
      await store.set('c', entry(100)); // evicts 'a' from memory

      // 'a' still on disk
      expect(
        deps.fs.files.has(`${CACHE_DIR}/${BUILD_ID}/entries/h_a.json`),
      ).toBe(true);
      // 'a' still retrievable via disk fallback
      const a = await store.get('a');
      expect(a).toBeDefined();
      await store.destroy();
    });

    test('get promotes to MRU position', async () => {
      const deps = fakeDeps();
      const store = createCacheStore(
        {
          maxByteSize: 200,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: false,
        },
        deps,
      );
      await store.set('a', entry(100));
      await store.set('b', entry(100));
      await store.get('a'); // promote a → MRU
      await store.set('c', entry(100)); // evicts b (now LRU)

      // 'a' should still be there in memory after eviction
      // (verifiable via load-tracking the fake fs reads)
      const reads: string[] = [];
      const origRead = deps.fs.read.bind(deps.fs);
      deps.fs.read = async (p: string) => {
        reads.push(p);
        return origRead(p);
      };

      await store.get('a');
      // No disk read for 'a' — still in memory
      expect(reads.some((r) => r.includes('h_a.json'))).toBe(false);
      await store.destroy();
    });
  });

  describe('Store > Persistence', () => {
    test('save flushes pending writes and writes index', async () => {
      const deps = fakeDeps();
      const store = createCacheStore(
        {
          maxByteSize: 1024,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: false,
        },
        deps,
      );
      await store.set('a', entry(50));
      await store.set('b', entry(50));
      await store.save();

      const indexRaw = deps.fs.files.get(`${CACHE_DIR}/${BUILD_ID}/index.json`);
      expect(indexRaw).toBeDefined();
      const index = JSON.parse(indexRaw as string);
      expect(Object.keys(index)).toHaveLength(2);
      expect(index.h_a).toBe('a');
      expect(index.h_b).toBe('b');
      await store.destroy();
    });

    test('reload from existing index — keys appear in store.keys', async () => {
      const deps = fakeDeps();
      // First lifecycle
      const store1 = createCacheStore(
        {
          maxByteSize: 1024,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: false,
        },
        deps,
      );
      await store1.set('a', entry(50));
      await store1.set('b', entry(50));
      await store1.save();
      await store1.destroy();

      // Second lifecycle, same fs
      const store2 = createCacheStore(
        {
          maxByteSize: 1024,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: false,
        },
        deps,
      );
      // Force ready
      await store2.get('__force_ready__');
      expect(store2.keys.has('a')).toBe(true);
      expect(store2.keys.has('b')).toBe(true);

      const a = await store2.get('a');
      expect(a?.body.byteLength).toBe(50);
      await store2.destroy();
    });

    test('reload with missing index — starts fresh', async () => {
      const deps = fakeDeps();
      const store = createCacheStore(
        {
          maxByteSize: 1024,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: false,
        },
        deps,
      );
      expect(await store.get('a')).toBeUndefined();
      expect(store.keys.size).toBe(0);
      await store.destroy();
    });

    test('reload with corrupted index — starts fresh', async () => {
      const deps = fakeDeps();
      deps.fs.files.set(
        `${CACHE_DIR}/${BUILD_ID}/index.json`,
        'not valid json',
      );

      const store = createCacheStore(
        {
          maxByteSize: 1024,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: false,
        },
        deps,
      );
      expect(await store.get('a')).toBeUndefined();
      expect(store.keys.size).toBe(0);
      await store.destroy();
    });

    test('reload with corrupted entry file — get returns undefined and untracks', async () => {
      const deps = fakeDeps();
      const store1 = createCacheStore(
        {
          maxByteSize: 1024,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: false,
        },
        deps,
      );
      await store1.set('a', entry(50));
      await store1.save();
      await store1.destroy();

      // Corrupt the entry file
      deps.fs.files.set(`${CACHE_DIR}/${BUILD_ID}/entries/h_a.json`, 'garbage');

      const store2 = createCacheStore(
        {
          maxByteSize: 1024,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: false,
        },
        deps,
      );
      expect(await store2.get('a')).toBeUndefined();
      await store2.destroy();
    });

    test('reload with missing entry file — get returns undefined', async () => {
      const deps = fakeDeps();
      const store1 = createCacheStore(
        {
          maxByteSize: 1024,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: false,
        },
        deps,
      );
      await store1.set('a', entry(50));
      await store1.save();
      await store1.destroy();

      // Delete entry file but keep index pointing to it
      deps.fs.files.delete(`${CACHE_DIR}/${BUILD_ID}/entries/h_a.json`);

      const store2 = createCacheStore(
        {
          maxByteSize: 1024,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: false,
        },
        deps,
      );
      expect(await store2.get('a')).toBeUndefined();
      await store2.destroy();
    });

    test('warmOnInit=true — preloads into memory', async () => {
      const deps = fakeDeps();
      const store1 = createCacheStore(
        {
          maxByteSize: 1024,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: false,
        },
        deps,
      );
      for (let i = 0; i < 10; i++) await store1.set(`k${i}`, entry(10));
      await store1.save();
      await store1.destroy();

      const store2 = createCacheStore(
        {
          maxByteSize: 1024,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: true,
        },
        deps,
      );
      // Trigger ready resolution
      await store2.get('__warmup__');
      // Yield to let warmCacheFromDisk finish
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // Now reads should hit memory — verify by tracking subsequent reads
      const reads: string[] = [];
      const origRead = deps.fs.read.bind(deps.fs);
      deps.fs.read = async (p: string) => {
        reads.push(p);
        return origRead(p);
      };
      await store2.get('k0');
      expect(reads.length).toBe(0);
      await store2.destroy();
    });

    test('warmOnInit respects budget — stops when over budget', async () => {
      const deps = fakeDeps();
      const store1 = createCacheStore(
        {
          maxByteSize: 10_000,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: false,
        },
        deps,
      );
      for (let i = 0; i < 20; i++) await store1.set(`k${i}`, entry(100));
      await store1.save();
      await store1.destroy();

      // Smaller budget on reload — warm should bail early
      const store2 = createCacheStore(
        {
          maxByteSize: 300,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: true,
        },
        deps,
      );
      await store2.get('__force_ready__');
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      // All 20 keys still tracked (persisted), but memory budget caps loaded count
      expect(store2.keys.size).toBe(20);
      await store2.destroy();
    });
  });

  describe('Store > Vacuum Old Builds', () => {
    test('removes old build dirs, preserves current', async () => {
      const deps = fakeDeps();

      const store1 = createCacheStore(
        {
          maxByteSize: 1024,
          cacheDir: CACHE_DIR,
          buildId: 'old-build',
          warmOnInit: false,
        },
        deps,
      );
      await store1.set('a', entry(50));
      await store1.save();
      await store1.destroy();

      expect(deps.fs.files.has(`${CACHE_DIR}/old-build/index.json`)).toBe(true);

      const store2 = createCacheStore(
        {
          maxByteSize: 1024,
          cacheDir: CACHE_DIR,
          buildId: 'new-build',
          warmOnInit: false,
        },
        deps,
      );
      await store2.get('__force_ready__');
      expect(deps.fs.files.has(`${CACHE_DIR}/old-build/index.json`)).toBe(
        false,
      );
      await store2.destroy();
    });

    test('preserves current build on subsequent open', async () => {
      const deps = fakeDeps();
      const store1 = createCacheStore(
        {
          maxByteSize: 1024,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: false,
        },
        deps,
      );
      await store1.set('a', entry(50));
      await store1.save();
      await store1.destroy();

      const store2 = createCacheStore(
        {
          maxByteSize: 1024,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: false,
        },
        deps,
      );
      const a = await store2.get('a');
      expect(a?.body.byteLength).toBe(50);
      await store2.destroy();
    });

    test('corrupted manifest — fresh start', async () => {
      const deps = fakeDeps();
      deps.fs.files.set(`${CACHE_DIR}/manifest.json`, 'broken');

      const store = createCacheStore(
        {
          maxByteSize: 1024,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: false,
        },
        deps,
      );
      await store.set('a', entry(50));
      expect(await store.get('a')).toBeDefined();
      await store.destroy();
    });

    test('manifest with no buildIds — works fine', async () => {
      const deps = fakeDeps();
      deps.fs.files.set(
        `${CACHE_DIR}/manifest.json`,
        JSON.stringify({ buildIds: [] }),
      );
      const store = createCacheStore(
        {
          maxByteSize: 1024,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: false,
        },
        deps,
      );
      await store.set('a', entry(50));
      expect(await store.get('a')).toBeDefined();
      await store.destroy();
    });
  });

  describe('Store > Index Debouncing', () => {
    test('debounced index write — fires after 1s via clock advance', async () => {
      const deps = fakeDeps();
      const store = createCacheStore(
        {
          maxByteSize: 1024,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: false,
        },
        deps,
      );
      await store.set('a', entry(50));
      // The disk write is fire-and-forget; flush microtasks so its `.then`
      // chain (which schedules the index timer) actually runs.
      await new Promise((r) => setImmediate(r));
      expect(deps.clock.pendingTimers()).toBeGreaterThan(0);

      deps.clock.advance(1000);
      // Yield so the index write promise (kicked off by the timer) resolves.
      await new Promise((r) => setImmediate(r));

      expect(deps.fs.files.has(`${CACHE_DIR}/${BUILD_ID}/index.json`)).toBe(
        true,
      );
      await store.destroy();
    });

    test('save clears pending timer and writes index immediately', async () => {
      const deps = fakeDeps();
      const store = createCacheStore(
        {
          maxByteSize: 1024,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: false,
        },
        deps,
      );
      await store.set('a', entry(50));
      await store.save();
      expect(deps.clock.pendingTimers()).toBe(0);
      expect(deps.fs.files.has(`${CACHE_DIR}/${BUILD_ID}/index.json`)).toBe(
        true,
      );
      await store.destroy();
    });

    test('multiple sets coalesce into single index write', async () => {
      const deps = fakeDeps();
      const store = createCacheStore(
        {
          maxByteSize: 1024,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: false,
        },
        deps,
      );
      await store.set('a', entry(50));
      await store.set('b', entry(50));
      await store.set('c', entry(50));
      // Flush microtasks so all three pending writes have scheduled their timers.
      await new Promise((r) => setImmediate(r));
      // Only one pending timer, not three
      expect(deps.clock.pendingTimers()).toBe(1);
      await store.destroy();
    });
  });

  describe('Store > Error Paths', () => {
    test('write failure during set is swallowed', async () => {
      const deps = fakeDeps();
      deps.fs.failOnce('write', 'h_a.json');

      const store = createCacheStore(
        {
          maxByteSize: 1024,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: false,
        },
        deps,
      );
      // Should not throw
      await store.set('a', entry(50));
      // Memory copy still there
      expect(await store.get('a')).toBeDefined();
      await store.destroy();
    });

    test('remove failure during delete is swallowed', async () => {
      const deps = fakeDeps();
      const store = createCacheStore(
        {
          maxByteSize: 1024,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: false,
        },
        deps,
      );
      await store.set('a', entry(50));
      deps.fs.failOnce('remove', 'h_a.json');
      await store.delete('a'); // should not throw
      await store.destroy();
    });

    test('destroy swallows index write failure', async () => {
      const deps = fakeDeps();
      const store = createCacheStore(
        {
          maxByteSize: 1024,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: false,
        },
        deps,
      );
      await store.set('a', entry(50));
      // Wait for the entry write to settle so the failOnce only catches the index write.
      await new Promise((r) => setImmediate(r));
      deps.fs.failOnce('write', 'index.json');
      await store.destroy(); // should not throw
    });

    test('scheduled index write failure is swallowed', async () => {
      const deps = fakeDeps();
      const store = createCacheStore(
        {
          maxByteSize: 1024,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: false,
        },
        deps,
      );
      await store.set('a', entry(50));
      // Flush so the timer is scheduled.
      await new Promise((r) => setImmediate(r));
      // Make the upcoming index write fail.
      deps.fs.failOnce('write', 'index.json');
      // Trigger the debounced timer — the catch in scheduleIndexWrite should swallow.
      deps.clock.advance(1000);
      // Yield so the rejection surfaces and gets caught.
      await new Promise((r) => setImmediate(r));
      // Index file was never written
      expect(deps.fs.files.has(`${CACHE_DIR}/${BUILD_ID}/index.json`)).toBe(
        false,
      );
      await store.destroy();
    });
  });

  describe('Store > Concurrency', () => {
    test('concurrent gets for same disk-only key share one read', async () => {
      const deps = fakeDeps();
      const store1 = createCacheStore(
        {
          maxByteSize: 200,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: false,
        },
        deps,
      );
      await store1.set('a', entry(50));
      await store1.save();
      await store1.destroy();

      const store2 = createCacheStore(
        {
          maxByteSize: 200,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: false,
        },
        deps,
      );

      const reads: string[] = [];
      const origRead = deps.fs.read.bind(deps.fs);
      deps.fs.read = async (p: string) => {
        reads.push(p);
        return origRead(p);
      };

      // Force ready first so read counts after start cleanly
      await store2.get('__warmup__');
      reads.length = 0;

      const results = await Promise.all([
        store2.get('a'),
        store2.get('a'),
        store2.get('a'),
      ]);
      for (const r of results) expect(r).toBeDefined();

      const entryReads = reads.filter((r) => r.includes('h_a.json'));
      expect(entryReads.length).toBe(1);

      await store2.destroy();
    });

    test('get during in-flight load — joins existing promise', async () => {
      const deps = fakeDeps();
      const store1 = createCacheStore(
        {
          maxByteSize: 200,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: false,
        },
        deps,
      );
      await store1.set('a', entry(50));
      await store1.save();
      await store1.destroy();

      const store2 = createCacheStore(
        {
          maxByteSize: 200,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: false,
        },
        deps,
      );
      await store2.get('__warmup__');

      const p1 = store2.get('a');
      const p2 = store2.get('a');
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toBeDefined();
      expect(r2).toBeDefined();
      await store2.destroy();
    });

    test('set during in-flight load promotes existing memory entry', async () => {
      const deps = fakeDeps();
      const store1 = createCacheStore(
        {
          maxByteSize: 1024,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: false,
        },
        deps,
      );
      await store1.set('contested', entry(100));
      await store1.save();
      await store1.destroy();

      const store2 = createCacheStore(
        {
          maxByteSize: 1024,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: false,
        },
        deps,
      );
      await store2.get('__warmup__');

      // Trigger disk load
      const getP = store2.get('contested');
      // Race: set arrives, populating memory before disk load resolves
      await store2.set('contested', entry(50));

      const result = await getP;
      expect(result).toBeDefined();
      await store2.destroy();
    });

    test('warmOnInit shares pendingLoad with concurrent get', async () => {
      const deps = fakeDeps();
      const store1 = createCacheStore(
        {
          maxByteSize: 4096,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: false,
        },
        deps,
      );
      // More than one batch (BATCH_SIZE = 8)
      for (let i = 0; i < 16; i++) await store1.set(`k${i}`, entry(10));
      await store1.save();
      await store1.destroy();

      const store2 = createCacheStore(
        {
          maxByteSize: 4096,
          cacheDir: CACHE_DIR,
          buildId: BUILD_ID,
          warmOnInit: true,
        },
        deps,
      );

      // While warm is running, fire concurrent gets
      const gets: Promise<unknown>[] = [];
      for (let i = 0; i < 16; i++) gets.push(store2.get(`k${i}`));

      const results = await Promise.all(gets);
      for (const r of results) expect(r).toBeDefined();

      // Let warm complete
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      await store2.destroy();
    });
  });

  describe('Default Dependencies', () => {
    test('end-to-end with real filesystem', async () => {
      const dir = tmpDir();
      const store = createCacheStore({
        maxByteSize: 1024,
        cacheDir: dir,
        buildId: BUILD_ID,
        warmOnInit: false,
      });

      await store.set('a', {
        body: new Uint8Array([1, 2, 3]),
        headers: [['x-test', 'val']],
        status: 200,
        cachedAt: Date.now(),
        sMaxAge: 60,
        swr: 0,
      });
      await store.save();

      // Files exist on disk
      const indexPath = join(dir, BUILD_ID, 'index.json');
      expect(existsSync(indexPath)).toBe(true);
      const index = JSON.parse(await Bun.file(indexPath).text());
      const hash = Object.keys(index)[0];
      expect(existsSync(join(dir, BUILD_ID, 'entries', `${hash}.json`))).toBe(
        true,
      );

      await store.destroy();

      // Reload from disk
      const store2 = createCacheStore({
        maxByteSize: 1024,
        cacheDir: dir,
        buildId: BUILD_ID,
        warmOnInit: true,
      });
      const a = await store2.get('a');
      expect(a).toBeDefined();
      expect(Array.from(a?.body ?? [])).toEqual([1, 2, 3]);
      await store2.destroy();
    });

    test('clock returns Date.now()', () => {
      const deps = defaultDeps();
      const before = Date.now();
      const now = deps.clock.now();
      const after = Date.now();
      expect(now).toBeGreaterThanOrEqual(before);
      expect(now).toBeLessThanOrEqual(after);
    });

    test('hash is deterministic sha256', () => {
      const deps = defaultDeps();
      const a = deps.hash('hello');
      const b = deps.hash('hello');
      const c = deps.hash('world');
      expect(a).toBe(b);
      expect(a).not.toBe(c);
      expect(a).toMatch(/^[0-9a-f]{64}$/);
    });

    test('fs.read returns undefined for missing file', async () => {
      const deps = defaultDeps();
      expect(
        await deps.fs.read(`/tmp/nonexistent-${Math.random()}`),
      ).toBeUndefined();
    });

    test('fs round-trip', async () => {
      const deps = defaultDeps();
      const dir = tmpDir();
      mkdirSync(dir, { recursive: true });
      const path = join(dir, 'test.txt');
      expect(await deps.fs.exists(path)).toBe(false);
      await deps.fs.write(path, 'hello');
      expect(await deps.fs.exists(path)).toBe(true);
      expect(await deps.fs.read(path)).toBe('hello');
      await deps.fs.remove(path);
      expect(await deps.fs.exists(path)).toBe(false);
    });

    test('fs.mkdir creates nested directories', async () => {
      const deps = defaultDeps();
      const dir = tmpDir();
      const nested = join(dir, 'a', 'b', 'c');
      await deps.fs.mkdir(nested);
      // Verify by writing a file inside it
      const path = join(nested, 'file.txt');
      await deps.fs.write(path, 'ok');
      expect(await deps.fs.read(path)).toBe('ok');
    });

    test('fs.removeDir removes recursively', async () => {
      const deps = defaultDeps();
      const dir = tmpDir();
      const sub = join(dir, 'sub');
      await deps.fs.mkdir(sub);
      await deps.fs.write(join(sub, 'a.txt'), 'a');
      await deps.fs.write(join(sub, 'b.txt'), 'b');
      expect(await deps.fs.exists(join(sub, 'a.txt'))).toBe(true);
      await deps.fs.removeDir(sub);
      expect(await deps.fs.exists(join(sub, 'a.txt'))).toBe(false);
      expect(await deps.fs.exists(sub)).toBe(false);
    });

    test('clock.setTimeout fires and is clearable', async () => {
      const deps = defaultDeps();
      let fired = false;
      const handle = deps.clock.setTimeout(() => {
        fired = true;
      }, 5);
      await new Promise((r) => setTimeout(r, 20));
      expect(fired).toBe(true);

      let firedClearable = false;
      const handle2 = deps.clock.setTimeout(() => {
        firedClearable = true;
      }, 5);
      handle2.clear();
      await new Promise((r) => setTimeout(r, 20));
      expect(firedClearable).toBe(false);
      // Just to keep handle in scope and exercise the type
      expect(handle).toBeDefined();
    });
  });
});
