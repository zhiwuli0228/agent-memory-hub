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
  /**
   * ADR-0018 central mode: when set, every WRITE (POST) requires
   * `Authorization: Bearer <authToken>`; reads (GET) stay open — the
   * distribution model is "gated on push, open on pull". Local-only
   * servers (default 127.0.0.1) run without it: zero friction.
   */
  authToken?: string
  /**
   * ADR-0021 large-team mode: per-domain write credentials. Each domain
   * token authorizes pushes INTO that domain (and only that one); the
   * global authToken is the admin key. The matched token is forwarded to
   * handlers via the x-memhub-token header for fine-grained checks.
   */
  domainTokens?: Record<string, string>
}

/** Write methods are gated when a token is configured; reads never are. */
function isWrite(method: string | undefined): boolean {
  return method === 'POST' || method === 'PUT' || method === 'DELETE'
}

function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null
  const m = /^Bearer\s+(.+)$/i.exec(header.trim())
  return m !== null && m[1] !== undefined && m[1] !== '' ? m[1] : null
}

export function startServer(state: ApiState, options?: ServeOptions): ReturnType<typeof createServer> {
  const domainValues = options?.domainTokens !== undefined ? Object.values(options.domainTokens) : []
  const server = createServer((req, res) => {
    // Central-mode write gate (ADR-0018/0021): pushes are controlled, pulls
    // are not. The write gate accepts the admin token OR any valid domain
    // token; the matched value travels downstream for domain-level checks.
    const token = options?.authToken
    if (token !== undefined && isWrite(req.method) && !bearerToken(req.headers['authorization'])) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'write requires Authorization: Bearer <token> (reads stay open)' }))
      return
    }
    const presented = bearerToken(req.headers['authorization'])
    const known = token !== undefined && presented === token
      ? 'admin'
      : presented !== null && domainValues.includes(presented)
        ? 'domain'
        : null
    if (token !== undefined && isWrite(req.method) && known === null) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unknown write credential (admin or domain token required)' }))
      return
    }
    void route(state, req, res, options)
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

async function route(state: ApiState, req: IncomingMessage, res: ServerResponse, options?: ServeOptions): Promise<void> {
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
    // Resolve the presented credential into an auth role for fine-grained
    // handlers (ADR-0021): admin key, a bound domain, or none.
    const presented = bearerToken(req.headers['authorization'])
    const adminToken = options?.authToken
    const auth = adminToken !== undefined && presented === adminToken
      ? { role: 'admin' as const, domainId: undefined }
      : presented !== null && options?.domainTokens !== undefined && Object.entries(options.domainTokens).find(([, v]) => v === presented) !== undefined
        ? { role: 'domain' as const, domainId: Object.entries(options.domainTokens).find(([, v]) => v === presented)?.[0] }
        : undefined
    const response = handleApi(state, req.method ?? 'GET', path, body, auth)
    res.writeHead(response.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(response.body))
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: `no route: ${req.method} ${path}` }))
}
