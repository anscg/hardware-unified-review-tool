/**
 * Streaming proxy for GitHub LFS binary downloads.
 *
 * The presigned S3 URLs returned by the LFS batch API
 * (`github-cloud.githubusercontent.com`) do not return CORS headers, so the
 * browser blocks direct fetches. This endpoint forwards the request and
 * streams the response back with permissive CORS headers.
 *
 * Request:
 *   GET /api/lfs-download?url={url-encoded presigned URL}
 *
 * For safety we only allow URLs on hosts that GitHub hands out for LFS.
 */

export const config = {
  runtime: 'edge',
};

const ALLOWED_HOSTS = new Set([
  'github-cloud.githubusercontent.com',
  'media.githubusercontent.com',
  'objects.githubusercontent.com',
]);

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type, Accept',
  'Access-Control-Expose-Headers':
    'Content-Length, Content-Type, Content-Range, Accept-Ranges, ETag',
  'Access-Control-Max-Age': '86400',
};

function withCors(headers: HeadersInit = {}): HeadersInit {
  return { ...CORS_HEADERS, ...headers };
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: withCors() });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: withCors({ 'Content-Type': 'application/json' }),
    });
  }

  const reqUrl = new URL(req.url);
  const target = reqUrl.searchParams.get('url');
  if (!target) {
    return new Response(JSON.stringify({ error: 'Missing url query param' }), {
      status: 400,
      headers: withCors({ 'Content-Type': 'application/json' }),
    });
  }

  let parsedTarget: URL;
  try {
    parsedTarget = new URL(target);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid url query param' }), {
      status: 400,
      headers: withCors({ 'Content-Type': 'application/json' }),
    });
  }

  if (!ALLOWED_HOSTS.has(parsedTarget.host)) {
    return new Response(
      JSON.stringify({ error: `Host not allowed: ${parsedTarget.host}` }),
      {
        status: 400,
        headers: withCors({ 'Content-Type': 'application/json' }),
      }
    );
  }

  // Forward Range header so seekable consumers (videos, partial reads) work.
  const forwardHeaders: HeadersInit = {};
  const range = req.headers.get('range');
  if (range) forwardHeaders['Range'] = range;

  const upstream = await fetch(parsedTarget.toString(), {
    method: req.method,
    headers: forwardHeaders,
  });

  const responseHeaders: Record<string, string> = { ...CORS_HEADERS };
  for (const passthrough of [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'etag',
    'last-modified',
    'cache-control',
  ]) {
    const value = upstream.headers.get(passthrough);
    if (value) responseHeaders[passthrough] = value;
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}
