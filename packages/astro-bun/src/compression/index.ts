import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';

export const COMPRESSIBLE_EXTENSIONS = [
  '.css',
  '.js',
  '.html',
  '.svg',
  '.json',
  '.xml',
  '.txt',
  '.mjs',
];

export type CompressionStats = {
  fileCount: number;
  bytesSaved: number;
};

/**
 * Recursively collect all compressible file paths under a directory.
 * Filters by `COMPRESSIBLE_EXTENSIONS`.
 */
async function walkCompressible(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkCompressible(full)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!COMPRESSIBLE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      continue;
    }
    files.push(full);
  }
  return files;
}

/**
 * Generate `.br` and `.gz` versions of every compressible file under
 * `clientDir`. Returns the count of compressed files and total bytes saved
 * (using whichever variant is smaller per file).
 */
export async function compressStaticAssets(
  clientDir: string,
): Promise<CompressionStats> {
  const files = await walkCompressible(clientDir);
  let bytesSaved = 0;

  for (const file of files) {
    const content = await readFile(file);
    const br = brotliCompressSync(content);
    const gz = gzipSync(content);

    await writeFile(`${file}.br`, br);
    await writeFile(`${file}.gz`, gz);

    bytesSaved += content.length - Math.min(br.length, gz.length);
  }

  return { fileCount: files.length, bytesSaved };
}
