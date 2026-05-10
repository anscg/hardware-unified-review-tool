/**
 * Proxy endpoint for the GitHub LFS batch API.
 *
 * GitHub's `/{owner}/{repo}.git/info/lfs/objects/batch` endpoint does not
 * return CORS headers, so browsers cannot call it directly. This serverless
 * function forwards the request server-side and returns the JSON response
 * with permissive CORS headers.
 *
 * Request:
 *   POST /api/lfs-batch?owner={owner}&repo={repo}
 *   Body: standard Git LFS batch JSON
 *     { "operation":"download", "transfers":["basic"], "objects":[{"oid":...,"size":...}] }
 */

type ApiRequest = {
  method?: string;
  query?: Record<string, string | string[]>;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
};

type ApiResponse = {
  status: (code: number) => ApiResponse;
  setHeader: (name: string, value: string) => void;
  end: (body?: string | Buffer) => void;
};

function setCors(res: ApiResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Accept, Authorization'
  );
  res.setHeader('Access-Control-Max-Age', '86400');
}

function pickString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

const OWNER_REPO_RE = /^[A-Za-z0-9_.-]+$/;

export default async function handler(
  req: ApiRequest,
  res: ApiResponse
): Promise<void> {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'application/json');
    res.status(405).end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const owner = pickString(req.query?.owner);
  const repo = pickString(req.query?.repo);

  if (!owner || !repo || !OWNER_REPO_RE.test(owner) || !OWNER_REPO_RE.test(repo)) {
    res.setHeader('Content-Type', 'application/json');
    res.status(400).end(
      JSON.stringify({ error: 'Missing or invalid owner/repo query params' })
    );
    return;
  }

  // Vercel parses JSON bodies automatically when Content-Type is application/json.
  // For our local Vite middleware we receive the raw body string.
  let bodyString: string;
  if (typeof req.body === 'string') {
    bodyString = req.body;
  } else if (req.body && typeof req.body === 'object') {
    bodyString = JSON.stringify(req.body);
  } else {
    res.setHeader('Content-Type', 'application/json');
    res.status(400).end(JSON.stringify({ error: 'Missing request body' }));
    return;
  }

  const upstream = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}.git/info/lfs/objects/batch`;

  try {
    const upstreamRes = await fetch(upstream, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/vnd.git-lfs+json',
        Accept: 'application/vnd.git-lfs+json',
      },
      body: bodyString,
    });

    const text = await upstreamRes.text();

    // Rewrite each object's download URL so that it points at our streaming
    // proxy, since the github-cloud.githubusercontent.com presigned URL
    // doesn't send CORS headers either.
    let payload = text;
    if (upstreamRes.ok) {
      try {
        const data = JSON.parse(text) as {
          objects?: Array<{
            actions?: { download?: { href?: string } };
          }>;
        };
        if (Array.isArray(data.objects)) {
          for (const obj of data.objects) {
            const href = obj?.actions?.download?.href;
            if (typeof href === 'string') {
              obj.actions!.download!.href =
                `/api/lfs-download?url=${encodeURIComponent(href)}`;
            }
          }
          payload = JSON.stringify(data);
        }
      } catch {
        // Leave the body untouched if it isn't valid JSON.
      }
    }

    res.setHeader(
      'Content-Type',
      upstreamRes.headers.get('content-type') ?? 'application/json'
    );
    res.status(upstreamRes.status).end(payload);
  } catch (error) {
    res.setHeader('Content-Type', 'application/json');
    res.status(502).end(
      JSON.stringify({
        error: 'LFS batch upstream request failed',
        message: error instanceof Error ? error.message : String(error),
      })
    );
  }
}
