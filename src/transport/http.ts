import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { PANEL_HTML } from './panel.js'
import { handleApi, type ApiState } from './server.js'

/**
 * HTTP adapter: thin node:http server delegating to the pure handleApi
 * router. Binds 127.0.0.1 by default (the panel is a local human channel).
 */

export interface ServeOptions {
  port?: number
  host?: string
}

export function startServer(state: ApiState, options?: ServeOptions): ReturnType<typeof createServer> {
  const server = createServer((req, res) => {
    void route(state, req, res)
  })
  server.listen(options?.port ?? 7777, options?.host ?? '127.0.0.1')
  return server
}

/** The URL the server is actually reachable at (resolves port 0 to the OS-assigned port). */
export function serverUrl(server: ReturnType<typeof createServer>): string {
  const address = server.address()
  if (address !== null && typeof address === 'object') {
    return `http://${address.address === '::' ? '127.0.0.1' : address.address}:${address.port}/`
  }
  return 'http://127.0.0.1/'
}

async function route(state: ApiState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname
  // CORS: the panel is consumed cross-origin (DSH web page on its own port
  // fetching 127.0.0.1:7777). The server binds loopback only and holds no
  // credentials, so a permissive header is the local-tool tradeoff.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  if (req.method === 'GET' && (path === '/' || path === '/panel')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PANEL_HTML)
    return
  }
  if (path.startsWith('/api/')) {
    let body: Record<string, unknown> | undefined
    // Query params flow into body so GET handlers can accept options (ADR-0012 hub pull since=).
    if (url.searchParams.size > 0) body = Object.fromEntries(url.searchParams.entries())
    if (req.method === 'POST') {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw !== '') {
        try {
          body = { ...(body ?? {}), ...(JSON.parse(raw) as Record<string, unknown>) }
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid JSON body' }))
          return
        }
      }
    }
    const response = handleApi(state, req.method ?? 'GET', path, body)
    res.writeHead(response.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(response.body))
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: `no route: ${req.method} ${path}` }))
}
