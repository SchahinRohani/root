import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import type { ManifestEntry, StaticManifest } from './types.ts';

/** Immutable cache for Vite-hashed assets, configurable for everything else. */
function getCacheControl(
  pathname: string,
  assetsPrefix: string,
  staticCacheControl: string,
): string {
  if (pathname.startsWith(`/${assetsPrefix}/`)) {
    return 'public, max-age=31536000, immutable';
  }
  return staticCacheControl;
}

/** Recursively collect all file paths under a directory. */
async function walk(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  const tasks: Promise<string[]>[] = [];

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      tasks.push(walk(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }

  const nested = await Promise.all(tasks);
  for (const list of nested) {
    for (const f of list) files.push(f);
  }

  return files;
}

/**
 * Derive the route pathname from a static file path.
 * `/about/index.html` → `/about`, `/index.html` → `/`, `/about.html` → `/about`
 */
function filePathToRoute(filePath: string): string {
  if (filePath.endsWith('/index.html')) {
    const route = filePath.slice(0, -'/index.html'.length);
    return route || '/';
  }
  if (filePath.endsWith('.html')) {
    return filePath.slice(0, -'.html'.length);
  }
  return filePath;
}

/** Infer MIME type from a file path using Bun's built-in detection. */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.webmanifest': 'application/manifest+json',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

function getMimeType(filePath: string): string | undefined {
  return MIME_TYPES[extname(filePath)];
}

/**
 * Walk the client build directory and write a static manifest with
 * pre-computed headers for each file (ETag, Content-Type, Cache-Control).
 */
export async function generateStaticManifest(
  clientDir: string,
  outDir: string,
  assetsPrefix: string,
  routeHeaders: Record<string, Record<string, string>> | undefined,
  staticCacheControl: string,
): Promise<void> {
  const files = await walk(clientDir);
  const manifest: StaticManifest = {};

  const entries = await Promise.all(
    files.map(async (filePath) => {
      const content = await readFile(filePath);
      const hash = createHash('sha256')
        .update(content)
        .digest('hex')
        .slice(0, 16);

      const pathname = `/${relative(clientDir, filePath)}`;
      const contentType = getMimeType(filePath);
      const headers: Record<string, string> = {
        'Cache-Control': getCacheControl(
          pathname,
          assetsPrefix,
          staticCacheControl,
        ),
        ...routeHeaders?.[filePathToRoute(pathname)],
        ETag: `"${hash}"`,
        'Content-Length': String(content.byteLength),
      };
      if (contentType) headers['Content-Type'] = contentType;

      const entry: ManifestEntry = {
        headers,
        filePath: relative(clientDir, filePath),
      };
      return [pathname, entry] as const;
    }),
  );

  for (const [pathname, entry] of entries) {
    manifest[pathname] = entry;

    // Route alias: `/about/index.html` also serves under `/about`
    const route = filePathToRoute(pathname);
    if (route !== pathname) {
      manifest[route] = { ...entry, filePath: pathname.slice(1) };
    }
  }

  await writeFile(
    join(outDir, 'static-manifest.json'),
    JSON.stringify(manifest),
  );
}
