import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { CacheEntry } from '../types.ts';

/**
 * Two-tier byte-limited LRU cache (functional).
 *
 * L1: in-memory LRU via doubly-linked list nodes.
 * L2: per-entry JSON files on disk.
 *
 * Evicted entries stay on disk and reload on next get().
 * TTL is not enforced here — `serve.ts` checks cachedAt + sMaxAge.
 */

// ─── Types ────────────────────────────────────────────────────────────────

type ListSentinel = {
  kind: 'sentinel';
  older: ListNode;
  newer: ListNode;
};

type ListEntry = {
  kind: 'entry';
  key: string;
  value: CacheEntry;
  size: number;
  older: ListNode;
  newer: ListNode;
};

type ListNode = ListSentinel | ListEntry;

type StoreState = {
  entries: Map<string, ListEntry>;
  head: ListSentinel;
  tail: ListSentinel;
  currentBytes: number;
  maxByteSize: number;
  cacheDir: string;
  buildId: string;
  warmOnInit: boolean;
  entriesDir: string;
  indexPath: string;
  persistedKeys: Set<string>;
  keyHashes: Map<string, string>;
  entriesDirCreated: boolean;
  indexDirty: boolean;
  indexTimer: ReturnType<typeof setTimeout> | undefined;
  pendingWrites: Set<Promise<void>>;
  pendingLoads: Map<string, Promise<CacheEntry | undefined>>;
  ready: Promise<void> | true;
  deps: StoreDeps;
};

export type StoreOptions = {
  maxByteSize: number;
  cacheDir: string;
  buildId: string;
  warmOnInit: boolean;
};

export type StoreDeps = {
  fs: FileSystem;
  clock: Clock;
  hash: (input: string) => string;
};

export type FileSystem = {
  read: (path: string) => Promise<string | undefined>;
  write: (path: string, data: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
  exists: (path: string) => Promise<boolean>;
  mkdir: (path: string) => Promise<void>;
  removeDir: (path: string) => Promise<void>;
};

export type Clock = {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => TimerHandle;
};

export type TimerHandle = {
  clear: () => void;
};

export type CacheStore = {
  get: (key: string) => Promise<CacheEntry | undefined>;
  set: (key: string, value: CacheEntry) => Promise<void>;
  delete: (key: string) => Promise<void>;
  keys: ReadonlySet<string>;
  save: () => Promise<void>;
  destroy: () => Promise<void>;
};

// ─── Pure: LRU list operations ────────────────────────────────────────────

function createListSentinel(): ListSentinel {
  const node = { kind: 'sentinel' } as ListSentinel;
  node.older = node;
  node.newer = node;
  return node;
}

function createListEntry(
  key: string,
  value: CacheEntry,
  size: number,
): ListEntry {
  return { kind: 'entry', key, value, size } as ListEntry;
}

function listInsertFront(head: ListSentinel, node: ListEntry): void {
  node.older = head;
  node.newer = head.newer;
  head.newer.older = node;
  head.newer = node;
}

function listDetach(node: ListEntry): void {
  node.older.newer = node.newer;
  node.newer.older = node.older;
}

function listMoveToFront(head: ListSentinel, node: ListEntry): void {
  listDetach(node);
  listInsertFront(head, node);
}

// ─── Pure: serialization ──────────────────────────────────────────────────

function encodeEntry(entry: CacheEntry): string {
  return JSON.stringify({ ...entry, body: Array.from(entry.body) });
}

function decodeEntry(raw: string): CacheEntry {
  const parsed = JSON.parse(raw);
  return { ...parsed, body: new Uint8Array(parsed.body) };
}

// ─── Pure: eviction ───────────────────────────────────────────────────────

function evictUntilUnderBudget(state: StoreState): void {
  while (state.currentBytes > state.maxByteSize && state.entries.size > 0) {
    const oldest = state.tail.older;
    if (oldest.kind === 'sentinel') break;
    listDetach(oldest);
    state.entries.delete(oldest.key);
    state.currentBytes -= oldest.size;
  }
}

// ─── Default IO adapters (Bun-backed) ─────────────────────────────────────

function defaultFileSystem(): FileSystem {
  return {
    async read(path) {
      const file = Bun.file(path);
      if (!(await file.exists())) return undefined;
      return file.text();
    },
    async write(path, data) {
      await Bun.write(path, data);
    },
    async remove(path) {
      await rm(path, { force: true });
    },
    async exists(path) {
      return Bun.file(path).exists();
    },
    async mkdir(path) {
      await mkdir(path, { recursive: true });
    },
    async removeDir(path) {
      await rm(path, { recursive: true, force: true });
    },
  };
}

function defaultClock(): Clock {
  return {
    now: () => Date.now(),
    setTimeout(fn, ms) {
      const t = setTimeout(fn, ms);
      t.unref();
      return { clear: () => clearTimeout(t) };
    },
  };
}

function defaultHash(input: string): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(input);
  return hasher.digest('hex');
}

export function defaultDeps(): StoreDeps {
  return {
    fs: defaultFileSystem(),
    clock: defaultClock(),
    hash: defaultHash,
  };
}

// ─── Internal helpers ─────────────────────────────────────────────────────

function hashKey(state: StoreState, key: string): string {
  const cached = state.keyHashes.get(key);
  if (cached) return cached;
  const hex = state.deps.hash(key);
  state.keyHashes.set(key, hex);
  return hex;
}

function entryFilePath(state: StoreState, hash: string): string {
  return join(state.entriesDir, `${hash}.json`);
}

async function ensureEntriesDir(state: StoreState): Promise<void> {
  if (state.entriesDirCreated) return;
  await state.deps.fs.mkdir(state.entriesDir);
  state.entriesDirCreated = true;
}

async function writeEntryToDisk(
  state: StoreState,
  key: string,
  value: CacheEntry,
): Promise<void> {
  const hash = hashKey(state, key);
  await ensureEntriesDir(state);
  await state.deps.fs.write(entryFilePath(state, hash), encodeEntry(value));
  state.indexDirty = true;
  scheduleIndexWrite(state);
}

async function readEntryFromDisk(
  state: StoreState,
  key: string,
): Promise<CacheEntry | undefined> {
  try {
    const hash = hashKey(state, key);
    const raw = await state.deps.fs.read(entryFilePath(state, hash));
    if (raw === undefined) {
      state.persistedKeys.delete(key);
      state.keyHashes.delete(key);
      return undefined;
    }
    const entry = decodeEntry(raw);

    const existing = state.entries.get(key);
    if (existing) {
      listMoveToFront(state.head, existing);
      return existing.value;
    }

    const size = entry.body.byteLength;
    const node = createListEntry(key, entry, size);
    state.entries.set(key, node);
    listInsertFront(state.head, node);
    state.currentBytes += size;
    evictUntilUnderBudget(state);

    return entry;
  } catch {
    state.persistedKeys.delete(key);
    state.keyHashes.delete(key);
    return undefined;
  } finally {
    state.pendingLoads.delete(key);
  }
}

async function removeEntryFromDisk(
  state: StoreState,
  key: string,
): Promise<void> {
  const hash = hashKey(state, key);
  state.persistedKeys.delete(key);
  state.keyHashes.delete(key);
  await state.deps.fs.remove(entryFilePath(state, hash));
  state.indexDirty = true;
  scheduleIndexWrite(state);
}

// ─── Index file ───────────────────────────────────────────────────────────

async function writeIndex(state: StoreState): Promise<void> {
  if (!state.indexDirty) return;
  const index: Record<string, string> = {};
  for (const [key, hash] of state.keyHashes) {
    if (state.persistedKeys.has(key)) index[hash] = key;
  }
  await state.deps.fs.write(state.indexPath, JSON.stringify(index));
  state.indexDirty = false;
}

function scheduleIndexWrite(state: StoreState): void {
  if (state.indexTimer || !state.indexDirty) return;
  state.indexTimer = state.deps.clock.setTimeout(() => {
    state.indexTimer = undefined;
    writeIndex(state).catch(() => {});
  }, 1000) as unknown as ReturnType<typeof setTimeout>;
}

function clearIndexTimer(state: StoreState): void {
  if (!state.indexTimer) return;
  (state.indexTimer as unknown as TimerHandle).clear();
  state.indexTimer = undefined;
}

// ─── Build directory lifecycle ────────────────────────────────────────────

async function vacuumOldBuilds(state: StoreState): Promise<void> {
  const manifestPath = join(state.cacheDir, 'manifest.json');
  let manifest: { buildIds: string[] } = { buildIds: [] };
  const raw = await state.deps.fs.read(manifestPath);
  if (raw !== undefined) {
    try {
      manifest = JSON.parse(raw);
    } catch {
      /* start fresh */
    }
  }

  for (const oldId of manifest.buildIds) {
    if (oldId === state.buildId) continue;
    await state.deps.fs.removeDir(join(state.cacheDir, oldId));
  }

  await state.deps.fs.mkdir(state.cacheDir);
  await state.deps.fs.write(
    manifestPath,
    JSON.stringify({ buildIds: [state.buildId] }),
  );
}

async function initFromDisk(state: StoreState): Promise<void> {
  await vacuumOldBuilds(state);
  await ensureEntriesDir(state);

  const raw = await state.deps.fs.read(state.indexPath);
  if (raw === undefined) {
    state.ready = true;
    return;
  }

  let index: Record<string, string>;
  try {
    index = JSON.parse(raw);
  } catch {
    state.ready = true;
    return;
  }

  for (const [hash, key] of Object.entries(index)) {
    state.persistedKeys.add(key);
    state.keyHashes.set(key, hash);
  }
  state.ready = true;

  if (state.warmOnInit) void warmCacheFromDisk(state, index);
}

async function warmCacheFromDisk(
  state: StoreState,
  index: Record<string, string>,
): Promise<void> {
  const BATCH_SIZE = 8;
  const keys = Object.values(index);

  for (let i = 0; i < keys.length; i += BATCH_SIZE) {
    if (state.currentBytes >= state.maxByteSize) break;

    const batch: Promise<CacheEntry | undefined>[] = [];
    for (let j = i; j < Math.min(i + BATCH_SIZE, keys.length); j++) {
      const key = keys[j];
      if (!key) continue;
      if (state.entries.has(key)) continue;
      if (state.currentBytes >= state.maxByteSize) break;

      const inflight = state.pendingLoads.get(key);
      if (inflight) {
        batch.push(inflight);
        continue;
      }

      const p = readEntryFromDisk(state, key);
      state.pendingLoads.set(key, p);
      batch.push(p);
    }

    await Promise.all(batch);
  }
}

async function ensureReady(state: StoreState): Promise<void> {
  if (state.ready !== true) await state.ready;
}

function trackWrite(state: StoreState, p: Promise<void>): void {
  state.pendingWrites.add(p);
  void p.finally(() => state.pendingWrites.delete(p));
}

// ─── Public factory ───────────────────────────────────────────────────────

/** Create a persistent two-tier LRU cache (L1 memory + L2 disk). */
export function createCacheStore(
  options: StoreOptions,
  deps: StoreDeps = defaultDeps(),
): CacheStore {
  const head = createListSentinel();
  const tail = createListSentinel();
  head.newer = tail;
  tail.older = head;

  const state: StoreState = {
    entries: new Map(),
    head,
    tail,
    currentBytes: 0,
    maxByteSize: options.maxByteSize,
    cacheDir: options.cacheDir,
    buildId: options.buildId,
    warmOnInit: options.warmOnInit,
    entriesDir: join(options.cacheDir, options.buildId, 'entries'),
    indexPath: join(options.cacheDir, options.buildId, 'index.json'),
    persistedKeys: new Set(),
    keyHashes: new Map(),
    entriesDirCreated: false,
    indexDirty: false,
    indexTimer: undefined,
    pendingWrites: new Set(),
    pendingLoads: new Map(),
    ready: true,
    deps,
  };

  state.ready = initFromDisk(state);

  return {
    async get(key) {
      await ensureReady(state);
      const node = state.entries.get(key);
      if (node) {
        listMoveToFront(state.head, node);
        return node.value;
      }
      const inflight = state.pendingLoads.get(key);
      if (inflight) return inflight;
      if (!state.persistedKeys.has(key)) return undefined;
      const p = readEntryFromDisk(state, key);
      state.pendingLoads.set(key, p);
      return p;
    },

    async set(key, value) {
      await ensureReady(state);
      const size = value.body.byteLength;
      if (size > state.maxByteSize) return;

      const existing = state.entries.get(key);
      if (existing) {
        existing.value = value;
        state.currentBytes = state.currentBytes - existing.size + size;
        existing.size = size;
        listMoveToFront(state.head, existing);
      } else {
        const node = createListEntry(key, value, size);
        state.entries.set(key, node);
        listInsertFront(state.head, node);
        state.currentBytes += size;
      }

      evictUntilUnderBudget(state);

      state.persistedKeys.add(key);
      trackWrite(
        state,
        writeEntryToDisk(state, key, value).catch(() => {}),
      );
    },

    async delete(key) {
      await ensureReady(state);
      const node = state.entries.get(key);
      if (node) {
        listDetach(node);
        state.entries.delete(key);
        state.currentBytes -= node.size;
      }
      if (state.persistedKeys.has(key)) {
        trackWrite(
          state,
          removeEntryFromDisk(state, key).catch(() => {}),
        );
      }
    },

    get keys() {
      return state.persistedKeys as ReadonlySet<string>;
    },

    async save() {
      await Promise.all(state.pendingWrites);
      clearIndexTimer(state);
      await writeIndex(state);
    },

    async destroy() {
      await Promise.all(state.pendingWrites);
      clearIndexTimer(state);
      await writeIndex(state).catch(() => {});
    },
  };
}

// ─── Test-only exports ────────────────────────────────────────────────────

/** @internal Exposed only for unit tests. Do not use. */
export const __test__ = {
  createListSentinel,
  createListEntry,
  listInsertFront,
  listDetach,
  listMoveToFront,
  encodeEntry,
  decodeEntry,
};
