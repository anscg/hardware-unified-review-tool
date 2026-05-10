import { defineConfig, type Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import react from '@vitejs/plugin-react'

// Lightweight dev-only mount for the Vercel-style serverless functions in `/api`.
// In production these are served by Vercel; locally we proxy them through Vite
// so endpoints like `/api/lfs-batch` and `/api/lfs-download` work under
// `vite dev`.
function devApiPlugin(): Plugin {
  return {
    name: 'dev-api',
    apply: 'serve',
    configureServer(server) {
      // /api/lfs-batch — Node-style handler (req/res with status/setHeader/end)
      server.middlewares.use('/api/lfs-batch', async (req, res) => {
        try {
          const mod = await server.ssrLoadModule('/api/lfs-batch.ts')
          const handler = (mod as { default: Function }).default

          const url = new URL(req.url ?? '/', 'http://localhost')
          const query: Record<string, string> = {}
          url.searchParams.forEach((value, key) => {
            query[key] = value
          })

          const chunks: Buffer[] = []
          for await (const chunk of req) {
            chunks.push(chunk as Buffer)
          }
          const bodyText = Buffer.concat(chunks).toString('utf8')

          const adaptedReq = {
            method: req.method,
            query,
            headers: req.headers,
            body: bodyText,
          }

          const adaptedRes = {
            status(code: number) {
              res.statusCode = code
              return adaptedRes
            },
            setHeader(name: string, value: string) {
              res.setHeader(name, value)
            },
            end(body?: string | Buffer) {
              res.end(body)
            },
          }

          await handler(adaptedReq, adaptedRes)
        } catch (error) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(
            JSON.stringify({
              error: 'Dev API handler failed',
              message: error instanceof Error ? error.message : String(error),
            })
          )
        }
      })

      // /api/lfs-download — Edge-runtime handler (Request -> Response)
      server.middlewares.use(
        '/api/lfs-download',
        async (req: IncomingMessage, res: ServerResponse) => {
          try {
            const mod = await server.ssrLoadModule('/api/lfs-download.ts')
            const handler = (mod as { default: Function }).default

            const fullUrl = new URL(
              req.url ?? '/',
              `http://${req.headers.host ?? 'localhost'}`
            )

            const requestHeaders = new Headers()
            for (const [key, value] of Object.entries(req.headers)) {
              if (Array.isArray(value)) {
                for (const v of value) requestHeaders.append(key, v)
              } else if (typeof value === 'string') {
                requestHeaders.set(key, value)
              }
            }

            const fetchRequest = new Request(fullUrl.toString(), {
              method: req.method,
              headers: requestHeaders,
              // No body needed for GET/HEAD/OPTIONS
            })

            const fetchResponse: Response = await handler(fetchRequest)

            res.statusCode = fetchResponse.status
            fetchResponse.headers.forEach((value, key) => {
              res.setHeader(key, value)
            })

            if (fetchResponse.body) {
              const nodeStream = Readable.fromWeb(fetchResponse.body as any)
              nodeStream.pipe(res)
            } else {
              res.end()
            }
          } catch (error) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({
                error: 'Dev API handler failed',
                message: error instanceof Error ? error.message : String(error),
              })
            )
          }
        }
      )
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), devApiPlugin()],
  optimizeDeps: {
    exclude: ['occt-import-js'],
    entries: ['index.html'],
  },
  server: {
    watch: {
      ignored: ['**/kicanvas/**', '**/3dcanvas/**'],
    },
  },
})
