import * as http from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import lfsBatch from './api/lfs-batch.ts'
import lfsDownload from './api/lfs-download.ts'
import stepToGlb from './api/step-to-glb.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(__dirname, 'dist')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.ico':  'image/x-icon',
  '.wasm': 'application/wasm',
  '.glb':  'model/gltf-binary',
  '.ttf':  'font/ttf',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
}

type NodeRes = {
  _code: number
  status(code: number): NodeRes
  setHeader(name: string, value: string): void
  end(data?: string | Buffer): void
}

function makeNodeRes(res: http.ServerResponse): NodeRes {
  const adapted: NodeRes = {
    _code: 200,
    status(code) { this._code = code; return this },
    setHeader(name, value) { res.setHeader(name, value) },
    end(data) { res.statusCode = this._code; res.end(data) },
  }
  return adapted
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const pathname = url.pathname

  if (pathname.startsWith('/api/')) {
    const query: Record<string, string> = {}
    url.searchParams.forEach((v, k) => { query[k] = v })

    try {
      if (pathname === '/api/lfs-batch') {
        await lfsBatch(
          {
            method: req.method,
            query,
            headers: req.headers as Record<string, string | string[] | undefined>,
            body: await readBody(req),
          },
          makeNodeRes(res),
        )
      } else if (pathname === '/api/lfs-download') {
        const headers = new Headers()
        for (const [k, v] of Object.entries(req.headers)) {
          if (Array.isArray(v)) v.forEach(vv => headers.append(k, vv))
          else if (v) headers.set(k, v)
        }
        const fetchRes = await lfsDownload(new Request(url.toString(), { method: req.method, headers }))
        res.statusCode = fetchRes.status
        fetchRes.headers.forEach((v, k) => res.setHeader(k, v))
        fetchRes.body ? Readable.fromWeb(fetchRes.body as any).pipe(res) : res.end()
      } else if (pathname === '/api/step-to-glb') {
        await stepToGlb(
          {
            method: req.method,
            query,
            headers: req.headers as Record<string, string | string[] | undefined>,
          },
          makeNodeRes(res),
        )
      } else {
        res.statusCode = 404
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: 'Not found' }))
      }
    } catch (err) {
      console.error(err)
      if (!res.headersSent) {
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
      }
    }
    return
  }

  // Static file serving with SPA fallback
  let filePath = path.join(DIST, pathname === '/' ? 'index.html' : pathname)
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html')
  }
  if (!fs.existsSync(filePath)) {
    filePath = path.join(DIST, 'index.html')
  }

  const ext = path.extname(filePath).toLowerCase()
  const stat = fs.statSync(filePath)
  res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream')
  res.setHeader('Content-Length', stat.size)
  fs.createReadStream(filePath).pipe(res)
})

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 80
server.listen(PORT, () => console.log(`HURT running on :${PORT}`))
