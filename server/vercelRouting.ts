/**
 * Vercel routing for the serverless entry. Outside Next.js, Vercel did not treat api/[...path].ts
 * as a catch-all: it matched one path segment, so /api/slate reached the function while
 * /api/game/<id> and /api/team/<id> got Vercel's own 404. vercel.json now rewrites every /api/...
 * request to the one function in api/index.ts and carries the original path in the __path query
 * parameter. This restores that original URL, keeping the request's own query, so the function
 * routes exactly as the persistent server does.
 */
const CARRIED = '__path';
const SAFE_PATH = /^[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;

export function originalApiUrl(url: string | undefined): string {
  const raw = url ?? '/';
  const parsed = new URL(raw, 'http://gridiron.invalid');
  const carried = parsed.searchParams.get(CARRIED);
  if (carried === null) return raw;
  parsed.searchParams.delete(CARRIED);
  const path = carried.replace(/^\/+/, '');
  // An unexpected path becomes one no route answers, rather than a guess.
  if (!SAFE_PATH.test(path)) return '/api/not-found';
  const query = parsed.searchParams.toString();
  return `/api/${path}${query ? `?${query}` : ''}`;
}
