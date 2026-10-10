/**
 * Narrow a `fetch` first argument to a URL string.
 *
 * `RequestInfo` includes the `Request` object form, whose default stringification is
 * `[object Object]` — so `String(input)` would silently pass while asserting nothing.
 */
export function fetchUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}
