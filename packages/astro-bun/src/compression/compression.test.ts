import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { COMPRESSIBLE_EXTENSIONS, compressStaticAssets } from './index.ts';
import { resolveCompressed } from './serve.ts';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'astro-bun-compression-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('Compression', () => {
  describe('Extensions', () => {
    test('exports a list of compressible extensions', () => {
      expect(COMPRESSIBLE_EXTENSIONS).toEqual([
        '.css',
        '.js',
        '.html',
        '.svg',
        '.json',
        '.xml',
        '.txt',
        '.mjs',
      ]);
    });
  });

  describe('Static Assets', () => {
    test('returns zero stats when directory is empty', async () => {
      const stats = await compressStaticAssets(tmpDir);

      expect(stats.fileCount).toBe(0);
      expect(stats.bytesSaved).toBe(0);
    });

    test('compresses a single file with .br and .gz output', async () => {
      const filePath = join(tmpDir, 'index.html');
      const content = '<!DOCTYPE html><html><body>Hello, World!</body></html>';
      await writeFile(filePath, content);

      const stats = await compressStaticAssets(tmpDir);

      const br = await readFile(`${filePath}.br`);
      const gz = await readFile(`${filePath}.gz`);

      expect(brotliDecompressSync(br).toString()).toBe(content);
      expect(gunzipSync(gz).toString()).toBe(content);
      expect(stats.fileCount).toBe(1);
    });

    test('compresses files for every supported extension', async () => {
      const files: ReadonlyArray<readonly [string, string]> = [
        ['style.css', 'body { color: red; }'],
        ['app.js', 'console.log("hi");'],
        ['page.html', '<html></html>'],
        ['icon.svg', '<svg></svg>'],
        ['data.json', '{"key":"value"}'],
        ['feed.xml', '<?xml version="1.0"?><root/>'],
        ['robots.txt', 'User-agent: *'],
        ['module.mjs', 'export default {};'],
      ];

      for (const [name, content] of files) {
        await writeFile(join(tmpDir, name), content);
      }

      const stats = await compressStaticAssets(tmpDir);

      for (const [name] of files) {
        expect(await Bun.file(join(tmpDir, `${name}.br`)).exists()).toBe(true);
        expect(await Bun.file(join(tmpDir, `${name}.gz`)).exists()).toBe(true);
      }

      expect(stats.fileCount).toBe(files.length);
    });

    test('skips files with non-compressible extensions', async () => {
      await writeFile(join(tmpDir, 'image.png'), 'fake png content');
      await writeFile(join(tmpDir, 'video.mp4'), 'fake mp4 content');
      await writeFile(join(tmpDir, 'archive.zip'), 'fake zip content');

      const stats = await compressStaticAssets(tmpDir);

      expect(await Bun.file(join(tmpDir, 'image.png.br')).exists()).toBe(false);
      expect(await Bun.file(join(tmpDir, 'video.mp4.br')).exists()).toBe(false);
      expect(await Bun.file(join(tmpDir, 'archive.zip.br')).exists()).toBe(
        false,
      );
      expect(stats.fileCount).toBe(0);
    });

    test('recurses into nested directories', async () => {
      await mkdir(join(tmpDir, 'sub', 'deeper'), { recursive: true });
      await writeFile(join(tmpDir, 'top.css'), 'a{}');
      await writeFile(join(tmpDir, 'sub', 'middle.js'), 'var x = 1;');
      await writeFile(
        join(tmpDir, 'sub', 'deeper', 'leaf.html'),
        '<p>deep</p>',
      );

      const stats = await compressStaticAssets(tmpDir);

      expect(await Bun.file(join(tmpDir, 'top.css.br')).exists()).toBe(true);
      expect(await Bun.file(join(tmpDir, 'sub', 'middle.js.br')).exists()).toBe(
        true,
      );
      expect(
        await Bun.file(join(tmpDir, 'sub', 'deeper', 'leaf.html.br')).exists(),
      ).toBe(true);
      expect(stats.fileCount).toBe(3);
    });

    test('mixes compressible and non-compressible files in the same directory', async () => {
      await writeFile(join(tmpDir, 'page.html'), '<html></html>');
      await writeFile(join(tmpDir, 'image.png'), 'binary');
      await writeFile(join(tmpDir, 'style.css'), 'body{}');
      await writeFile(join(tmpDir, 'video.webm'), 'binary');

      const stats = await compressStaticAssets(tmpDir);

      expect(await Bun.file(join(tmpDir, 'page.html.br')).exists()).toBe(true);
      expect(await Bun.file(join(tmpDir, 'style.css.br')).exists()).toBe(true);
      expect(await Bun.file(join(tmpDir, 'image.png.br')).exists()).toBe(false);
      expect(await Bun.file(join(tmpDir, 'video.webm.br')).exists()).toBe(
        false,
      );
      expect(stats.fileCount).toBe(2);
    });

    test('skips non-file entries (e.g. symlinks)', async () => {
      const targetPath = join(tmpDir, 'target.css');
      await writeFile(targetPath, 'a{}');

      const linkPath = join(tmpDir, 'link.css');
      await symlink(targetPath, linkPath);

      const stats = await compressStaticAssets(tmpDir);

      // Real file gets compressed
      expect(await Bun.file(`${targetPath}.br`).exists()).toBe(true);

      // Symlink is not a regular file, gets skipped
      expect(await Bun.file(`${linkPath}.br`).exists()).toBe(false);
      expect(stats.fileCount).toBe(1);
    });

    test('handles empty files', async () => {
      const filePath = join(tmpDir, 'empty.css');
      await writeFile(filePath, '');

      const stats = await compressStaticAssets(tmpDir);

      const br = await readFile(`${filePath}.br`);
      const gz = await readFile(`${filePath}.gz`);

      expect(brotliDecompressSync(br).toString()).toBe('');
      expect(gunzipSync(gz).toString()).toBe('');
      expect(stats.fileCount).toBe(1);
    });

    test('reports positive bytesSaved for highly compressible content', async () => {
      // Highly repetitive content compresses well — exercises the bytesSaved
      // accumulation path with both br and gz being smaller than the original.
      const content = 'a'.repeat(10_000);
      await writeFile(join(tmpDir, 'large.txt'), content);

      const stats = await compressStaticAssets(tmpDir);

      expect(stats.bytesSaved).toBeGreaterThan(0);
    });

    test('reports zero or near-zero bytesSaved for tiny content', async () => {
      // Tiny content has little compression potential; bytesSaved may be
      // small or even negative in theory, but we just check it's a number.
      await writeFile(join(tmpDir, 'tiny.css'), 'a{}');

      const stats = await compressStaticAssets(tmpDir);

      expect(typeof stats.bytesSaved).toBe('number');
      expect(stats.fileCount).toBe(1);
    });
  });

  describe('resolveCompressed', () => {
    test('returns brotli when client accepts br and .br exists', async () => {
      const filePath = join(tmpDir, 'app.js');
      await writeFile(filePath, 'original');
      await writeFile(`${filePath}.br`, 'compressed');

      const result = resolveCompressed(filePath, 'br, gzip, deflate');

      expect(result.encoding).toBe('br');
      expect(result.path).toBe(`${filePath}.br`);
    });

    test('returns gzip when client accepts gzip and only .gz exists', async () => {
      const filePath = join(tmpDir, 'app.js');
      await writeFile(filePath, 'original');
      await writeFile(`${filePath}.gz`, 'compressed');

      const result = resolveCompressed(filePath, 'gzip, deflate');

      expect(result.encoding).toBe('gzip');
      expect(result.path).toBe(`${filePath}.gz`);
    });

    test('prefers brotli over gzip when both are accepted and both exist', async () => {
      const filePath = join(tmpDir, 'app.js');
      await writeFile(filePath, 'original');
      await writeFile(`${filePath}.br`, 'br-compressed');
      await writeFile(`${filePath}.gz`, 'gz-compressed');

      const result = resolveCompressed(filePath, 'br, gzip');

      expect(result.encoding).toBe('br');
      expect(result.path).toBe(`${filePath}.br`);
    });

    test('falls back to gzip when client accepts both but only .gz exists', async () => {
      const filePath = join(tmpDir, 'app.js');
      await writeFile(filePath, 'original');
      await writeFile(`${filePath}.gz`, 'compressed');

      const result = resolveCompressed(filePath, 'br, gzip');

      expect(result.encoding).toBe('gzip');
      expect(result.path).toBe(`${filePath}.gz`);
    });

    test('returns original when client accepts br but .br does not exist', async () => {
      const filePath = join(tmpDir, 'app.js');
      await writeFile(filePath, 'original');

      const result = resolveCompressed(filePath, 'br');

      expect(result.encoding).toBeNull();
      expect(result.path).toBe(filePath);
    });

    test('returns original when client accepts gzip but .gz does not exist', async () => {
      const filePath = join(tmpDir, 'app.js');
      await writeFile(filePath, 'original');

      const result = resolveCompressed(filePath, 'gzip');

      expect(result.encoding).toBeNull();
      expect(result.path).toBe(filePath);
    });

    test('returns original when client accepts neither br nor gzip', async () => {
      const filePath = join(tmpDir, 'app.js');
      await writeFile(filePath, 'original');
      await writeFile(`${filePath}.br`, 'compressed');
      await writeFile(`${filePath}.gz`, 'compressed');

      const result = resolveCompressed(filePath, 'identity');

      expect(result.encoding).toBeNull();
      expect(result.path).toBe(filePath);
    });

    test('returns original when accept-encoding is empty', async () => {
      const filePath = join(tmpDir, 'app.js');
      await writeFile(filePath, 'original');
      await writeFile(`${filePath}.br`, 'compressed');

      const result = resolveCompressed(filePath, '');

      expect(result.encoding).toBeNull();
      expect(result.path).toBe(filePath);
    });

    test('skips br branch when client only accepts gzip, even if .br exists', async () => {
      const filePath = join(tmpDir, 'app.js');
      await writeFile(filePath, 'original');
      await writeFile(`${filePath}.br`, 'br-compressed');
      await writeFile(`${filePath}.gz`, 'gz-compressed');

      const result = resolveCompressed(filePath, 'gzip');

      expect(result.encoding).toBe('gzip');
      expect(result.path).toBe(`${filePath}.gz`);
    });
  });
});
