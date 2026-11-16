import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendLedger, ledgerPath, readSequences, writeSequences } from '../src/core/ledger.js'
import { commitKnowledge } from '../src/core/store.js'
import { initHub, readHubConfig } from '../src/core/hub.js'
import { publishCommand, type PublishTransport } from '../src/cli.js'
import type { LedgerRecord } from '../src/core/ledger.js'

function helpers() {
  return {
    readSequences,
    writeSequences,
    appendLedger: (root: string, record: LedgerRecord) => appendLedger(ledgerPath(root), record),
  }
}

function tempHub(): string {
  const root = mkdtempSync(join(tmpdir(), 'amh-publish-'))
  initHub(root)
  return root
}

function seed(root: string, title: string): string {
  return commitKnowledge(root, { type: 'process', title, summary: '通用流程', scope: { level: 'global' }, tags: [], body: '正文', sourceRefs: ['n'] }, helpers()).id
}

describe('ADR-0015 publish — the outbound API is the team\'s own to define', () => {
  it('adapter none (default) returns config guidance instead of guessing an API', async () => {
    const root = tempHub()
    const r = await publishCommand(root, [])
    expect(r.ok).toBe(false)
    expect(String(r.hint)).toContain('publish.adapter')
  })

  it('http adapter POSTs the full entry payload to the configured endpoint', async () => {
    const root = tempHub()
    const id = seed(root, '通用登录部署')
    // The team defines their own contract in hub.yaml (flat keys, diff-friendly).
    const yamlPath = join(root, 'hub.yaml')
    writeFileSync(yamlPath, readFileSync(yamlPath, 'utf8') + 'publish.adapter: http\npublish.endpoint: https://memory.internal/api/entries\npublish.header.Authorization: Bearer team-token\n')
    const received: Array<{ url: string; headers: Record<string, string>; body: string }> = []
    const transport: PublishTransport = async (url, init) => {
      received.push({ url, headers: init.headers, body: init.body })
      return { ok: true, status: 200, body: '{"accepted":1}' }
    }
    const r = await publishCommand(root, [], transport)
    expect(r.ok).toBe(true)
    expect(r.published).toBe(1)
    expect(received).toHaveLength(1)
    expect(received[0]?.url).toBe('https://memory.internal/api/entries')
    expect(received[0]?.headers['Authorization']).toBe('Bearer team-token')
    const payload = JSON.parse(received[0]?.body ?? '{}') as { entries: Array<{ id: string; title: string; body: string }> }
    expect(payload.entries[0]?.id).toBe(id)
    expect(payload.entries[0]?.title).toBe('通用登录部署')
    // Watermark + ledger recorded
    expect(existsSync(join(root, 'records', 'publish-state.json'))).toBe(true)
  })

  it('exec adapter runs the team\'s own script (stdin = entries JSON) — their API, their code', async () => {
    const root = tempHub()
    seed(root, '环境变量注入流程')
    const yamlPath = join(root, 'hub.yaml')
    writeFileSync(yamlPath, readFileSync(yamlPath, 'utf8') + 'publish.adapter: exec\npublish.script: push-to-hub.mjs\n')
    writeFileSync(join(root, 'push-to-hub.mjs'), [
      "import { readFileSync, writeFileSync } from 'node:fs'",
      "const input = JSON.parse(readFileSync(0, 'utf8'))",
      "writeFileSync('received.json', JSON.stringify(input))",
      "console.log('delivered ' + input.entries.length)",
    ].join('\n'))
    const r = await publishCommand(root, [])
    expect(r.ok).toBe(true)
    expect(String(r.detail)).toContain('delivered 1')
    const received = JSON.parse(readFileSync(join(root, 'received.json'), 'utf8') as unknown as string) as { entries: Array<{ title: string }> }
    expect(received.entries[0]?.title).toBe('环境变量注入流程')
  })

  it('explicit ids publish only those entries', async () => {
    const root = tempHub()
    seed(root, 'A')
    seed(root, 'B')
    const yamlPath = join(root, 'hub.yaml')
    writeFileSync(yamlPath, readFileSync(yamlPath, 'utf8') + 'publish.adapter: http\npublish.endpoint: https://memory.internal/api/entries\n')
    const bodies: string[] = []
    const transport: PublishTransport = async (_url, init) => {
      bodies.push(init.body)
      return { ok: true, status: 200, body: '{"accepted":1}' }
    }
    const r = await publishCommand(root, ['PRC-000002'], transport)
    expect(r.ok).toBe(true)
    expect(r.published).toBe(1)
    expect(r.ids).toEqual(['PRC-000002'])
    const payload = JSON.parse(bodies[0] ?? '{}') as { entries: Array<{ id: string; title: string }> }
    expect(payload.entries).toHaveLength(1)
    expect(payload.entries[0]?.title).toBe('B')
  })

  it('a transport-level exception (dead remote) degrades to an error result, never escapes', async () => {
    const root = tempHub()
    seed(root, 'A')
    const yamlPath = join(root, 'hub.yaml')
    writeFileSync(yamlPath, readFileSync(yamlPath, 'utf8') + 'publish.adapter: http\npublish.endpoint: http://127.0.0.1:1/v1/entries\n')
    const transport: PublishTransport = async () => {
      throw new Error('fetch failed: ECONNREFUSED')
    }
    const r = await publishCommand(root, [], transport)
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('publish transport failed')
    expect(String(r.error)).toContain('ECONNREFUSED')
    // Watermark untouched — retry-safe after the remote recovers.
    expect(existsSync(join(root, 'records', 'publish-state.json'))).toBe(false)
  })

  it('a failed outlet reports the error and does not bump the watermark', async () => {
    const root = tempHub()
    seed(root, 'A')
    const yamlPath = join(root, 'hub.yaml')
    writeFileSync(yamlPath, readFileSync(yamlPath, 'utf8') + 'publish.adapter: http\npublish.endpoint: https://memory.internal/api/entries\n')
    const transport: PublishTransport = async () => ({ ok: false, status: 500, body: 'boom' })
    const r = await publishCommand(root, [], transport)
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('boom')
    expect(existsSync(join(root, 'records', 'publish-state.json'))).toBe(false)
  })

  it('the reference exec script posts a spec-compliant payload (docs/02-spec v1)', async () => {
    const { spawnSync } = await import('node:child_process')
    const { createServer } = await import('node:http')
    const root = tempHub()
    seed(root, '规范一致性验证')
    const yamlPath = join(root, 'hub.yaml')
    // The outlet address is configured in hub.yaml (publish.env.<NAME>);
    // the token would normally come from the system env instead.
    writeFileSync(yamlPath, readFileSync(yamlPath, 'utf8') + 'publish.adapter: exec\npublish.script: push-to-hub.mjs\n')
    // Ship the reference script into the hub root (that is where exec runs it).
    const script = readFileSync(join(import.meta.dirname ?? '.', '..', 'examples', 'push-to-hub.mjs'), 'utf8')
    writeFileSync(join(root, 'push-to-hub.mjs'), script)

    const bodies: string[] = []
    const authHeaders: string[] = []
    const server = createServer((req, res) => {
      let data = ''
      authHeaders.push(String(req.headers['authorization'] ?? ''))
      req.on('data', (c: Buffer) => { data += c.toString() })
      req.on('end', () => {
        bodies.push(data)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ accepted: 1, rejected: [] }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    process.env.MEMORY_HUB_URL = `http://127.0.0.1:${port}`
    process.env.MEMORY_HUB_TOKEN = 't0ken'
    try {
      const r = await publishCommand(root, [])
      expect(r.ok).toBe(true)
      expect(String(r.detail)).toContain('delivered 1')
      // The reference script speaks exactly the spec: POST /v1/entries with
      // the {entries, publishedAt} body and a Bearer header.
      const payload = JSON.parse(bodies[0] ?? '{}') as { entries: Array<{ id: string; version: number; body: string }>; publishedAt: string }
      expect(payload.entries).toHaveLength(1)
      expect(payload.entries[0]?.id).toBe('PRC-000001')
      expect(typeof payload.entries[0]?.body).toBe('string')
      expect(typeof payload.publishedAt).toBe('string')
      expect(authHeaders[0]).toBe('Bearer t0ken')
    } finally {
      server.close()
      delete process.env.MEMORY_HUB_URL
      delete process.env.MEMORY_HUB_TOKEN
    }
  })
})
