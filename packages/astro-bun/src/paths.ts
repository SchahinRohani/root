import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ADAPTER_DIR_NAME = '.astro-bun-adapter';
const MAX_LOOKUP_DEPTH = 5;

/**
 * Walk up the directory tree from `start` looking for the adapter
 * artifacts directory (`.astro-bun-adapter`). The directory is written
 * by the build hook and contains the static manifest, build id, and
 * (optionally) the cache index.
 *
 * Throws if not found within `MAX_LOOKUP_DEPTH` parent directories.
 */
export function findAdapterDir(start: string): string {
  let dir = start;
  for (let i = 0; i < MAX_LOOKUP_DEPTH; i++) {
    const candidate = join(dir, ADAPTER_DIR_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not find ${ADAPTER_DIR_NAME} from ${start}`);
}
