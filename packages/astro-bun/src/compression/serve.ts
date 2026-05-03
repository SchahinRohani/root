import { existsSync } from 'node:fs';

/**
 * Pick the most preferred pre-compressed variant available on disk.
 *
 * Returns the path to the best matching file (`.br`, `.gz`, or original)
 * and the encoding to set on the `Content-Encoding` response header.
 */
export function resolveCompressed(
  filePath: string,
  acceptEncoding: string,
): { path: string; encoding: string | null } {
  if (acceptEncoding.includes('br')) {
    const br = `${filePath}.br`;
    if (existsSync(br)) return { path: br, encoding: 'br' };
  }
  if (acceptEncoding.includes('gzip')) {
    const gz = `${filePath}.gz`;
    if (existsSync(gz)) return { path: gz, encoding: 'gzip' };
  }
  return { path: filePath, encoding: null };
}
