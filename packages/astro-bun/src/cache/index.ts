import type { CacheControl } from '../types.ts';

const CACHE_KEY = Symbol.for('@scale.digital/astro-bun:cache');

/** Register the cache control instance on globalThis for cross-module access. */
export function registerCache(instance: CacheControl): void {
  (globalThis as Record<symbol, unknown>)[CACHE_KEY] = instance;
}

function getCache(): CacheControl | undefined {
  return (globalThis as Record<symbol, unknown>)[CACHE_KEY] as
    | CacheControl
    | undefined;
}

/**
 * Expire a cache entry by pathname. The entry is deleted and will be
 * re-rendered on the next request (lazy revalidation).
 *
 * No-op when caching is not enabled — safe to call unconditionally.
 *
 * @example
 * ```ts
 * import { unstable_expirePath } from "@scale.digital/astro-bun/cache";
 * await unstable_expirePath("/blog/my-post");
 * ```
 */
export async function unstable_expirePath(pathname: string): Promise<void> {
  const cache = getCache();
  if (!cache) return;
  await cache.expire(pathname);
}

/**
 * Expire all cache entries. Every cached page is deleted and will be
 * re-rendered on the next request (lazy revalidation).
 *
 * No-op when caching is not enabled — safe to call unconditionally.
 *
 * @example
 * ```ts
 * import { unstable_expireAll } from "@scale.digital/astro-bun/cache";
 * await unstable_expireAll();
 * ```
 */
export async function unstable_expireAll(): Promise<void> {
  const cache = getCache();
  if (!cache) return;
  await cache.expireAll();
}
