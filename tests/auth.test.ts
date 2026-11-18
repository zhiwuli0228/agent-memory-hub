import { createApiState, type ApiState } from '../src/transport/server.js'
import { startServer } from '../src/transport/http.js'
import { initHub } from '../src/core/hub.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { afterAll, describe, expect, it } from 'vitest'

let server: Server
let state: ApiState
const root = mkdtempSync(join(tmpdir(), 'amh-auth-'))
const TOKEN = 'central-secret-123'

async function url(path: string): Promise<string> {
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('no address')
  return `http://127.0.0.1:${addr.port}${path}`
}

describe('central mode auth (ADR-0018: gated push, open pull)', () => {
  afterAll(() => {
    server?.close()
    server?.closeAllConnections()
  })

  it('gates writes behind Bearer token while reads stay open', async () => {
    initHub(root)
    state = createApiState(root)
    server = startServer(state, { port: 0, authToken: TOKEN })
    await new Promise<void>((resolve) => server.on('listening', () => resolve()))
    const base = (p: string) => url(p)

    // READ: no token — open pull side.
    const read = await fetch(await base('/api/inbox'))
    expect(read.status).toBe(200)

    // WRITE without token: 401.
    const anon = await fetch(await base('/api/propose'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'process', title: 'x', summary: 's', scope: { level: 'global' }, tags: [], body: 'b', sourceRefs: ['t'] }),
    })
    expect(anon.status).toBe(401)

    // WRITE with wrong token: 401.
    const wrong = await fetch(await base('/api/propose'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
      body: JSON.stringify({ type: 'process', title: 'x', summary: 's', scope: { level: 'global' }, tags: [], body: 'b', sourceRefs: ['t'] }),
    })
    expect(wrong.status).toBe(401)

    // WRITE with correct token: accepted.
    const good = await fetch(await base('/api/propose'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ type: 'process', title: 'token gate test', summary: 's', scope: { level: 'global' }, tags: [], body: 'b', sourceRefs: ['t'] }),
    })
    expect(good.status).toBe(200)
  })

  it('local default mode (no token) keeps everything frictionless', async () => {
    server = startServer(state, { port: 0 })
    await new Promise<void>((resolve) => server.on('listening', () => resolve()))
    const base = (p: string) => url(p)
    const read = await fetch(await base('/api/inbox'))
    expect(read.status).toBe(200)
  })
})
