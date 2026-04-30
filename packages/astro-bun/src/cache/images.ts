/**
 * Astro image-endpoint query parameters that affect the rendered output.
 * Other parameters (e.g. cache busters, tracking IDs) are stripped from
 * the cache key so semantically equivalent requests share an entry.
 *
 * @see https://docs.astro.build/en/guides/images/
 */
const IMAGE_PARAMS = [
  'background',
  'f',
  'fit',
  'h',
  'href',
  'position',
  'q',
  'w',
];

/**
 * Build a normalized cache key for an Astro image endpoint request.
 *
 * Filters the URL search params down to the ones Astro actually uses
 * for image transformation, so unrelated query params don't fragment
 * the cache.
 */
export function buildImageCacheKey(
  pathname: string,
  params: URLSearchParams,
): string {
  const normalized = new URLSearchParams();
  for (const key of IMAGE_PARAMS) {
    const value = params.get(key);
    if (value !== null) normalized.set(key, value);
  }
  const qs = normalized.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}
