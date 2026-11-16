import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { appendLedger, ledgerPath, readSequences, writeSequences } from '../src/core/ledger.js'
import { commitKnowledge } from '../src/core/store.js'
import { initHub } from '../src/core/hub.js'
import { publishCommand } from '../src/cli.js'
import type { LedgerRecord } from '../src/core/ledger.js'

function helpers() {
  return {
    readSequences,
    writeSequences,
    appendLedger: (root: string, record: LedgerRecord) => appendLedger(ledgerPath(root), record),
  }
}

function tempHub(): string {
  const root = mkdtempSync(join(tmpdir(), 'amh-specsrv-'))
  initHub(root)
  return root
}

function seed(root: string, title: string, body: string): string {
  return commitKnowledge(root, { type: 'process', title, summary: title + ' 摘要', scope: { level: 'global' }, tags: ['deploy'], body, sourceRefs: ['n'] }, helpers()).id
}

let serverProcess: ReturnType<typeof spawn> | null = null
let baseUrl = ''
let dataDir = ''

async function startSpecServer(): Promise<void> {
  dataDir = mkdtempSync(join(tmpdir(), 'amh-specsrv-data-'))
  // Grab a free port with a throwaway listener, then run the reference server on it.
  const probe = spawnSync(process.execPath, ['-e', 'const s=require("net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})'], { encoding: 'utf8' })
  const port = probe.stdout.trim()
  serverProcess = spawn(process.execPath, [join(import.meta.dirname ?? '.', '..', 'examples', 'memory-hub-server.mjs')], {
    env: { ...process.env, PORT: port, DATA_DIR: dataDir },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  baseUrl = `http://127.0.0.1:${port}`
  for (let i = 0; i < 50; i += 1) {
    try {
      const r = await fetch(`${baseUrl}/v1/health`)
      if (r.ok) return
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('spec server did not start')
}

afterEach(() => {
  serverProcess?.kill('SIGKILL')
  serverProcess = null
})

describe('memory-hub-server reference implementation (docs/02-spec v1)', () => {
  it('accepts memhub publish payloads, enforces version upsert semantics, serves since + search', async () => {
    await startSpecServer()
    const root = tempHub()
    const first = seed(root, '通用环境登录部署', '正文一')
    const yamlPath = join(root, 'hub.yaml')
    writeFileSync(yamlPath, readFileSync(yamlPath, 'utf8') + 'publish.adapter: http\npublish.endpoint: ' + baseUrl + '/v1/entries\n')

    // 1. publish → server accepts
    const r1 = await publishCommand(root, [])
    expect(r1.ok).toBe(true)
    expect(r1.published).toBe(1)

    // 2. single-entry fetch returns full body
    const detail = await (await fetch(`${baseUrl}/v1/entries/${first}`)).json()
    expect(detail.body).toBe('正文一')

    // 3. publish an OLDER version → rejected as stale (no rollback)
    writeFileSync(yamlPath, readFileSync(yamlPath, 'utf8'))
    const r2 = await publishCommand(root, [first], async (url, init) => {
      const payload = JSON.parse(init.body) as { entries: Array<{ version: number }> }
      payload.entries[0].version = 0 // pretend an older revision slipped through
      const resp = await fetch(url, { method: init.method, headers: init.headers, body: JSON.stringify(payload) })
      return { ok: resp.ok, status: resp.status, body: await resp.text() }
    })
    expect(r2.ok).toBe(true)
    expect(String(r2.detail)).toContain('stale version')

    // 4. incremental since: publish a second entry, list only it
    const second = seed(root, '数据库连接池配置', '正文二')
    const r3 = await publishCommand(root, [second])
    expect(r3.ok).toBe(true)
    const list = await (await fetch(`${baseUrl}/v1/entries`)).json()
    expect(list.count).toBe(2)
    const incremental = await (await fetch(`${baseUrl}/v1/entries?since=${encodeURIComponent('2999-01-01T00:00:00.000Z')}`)).json()
    expect(incremental.count).toBe(0)

    // 5. runtime search hits by keyword with a normalized score
    const search = await (await fetch(`${baseUrl}/v1/search?q=${encodeURIComponent('连接池')}`)).json()
    expect(search.results.length).toBeGreaterThanOrEqual(1)
    expect(search.results[0].id).toBe(second)
    expect(search.results[0].score).toBeLessThanOrEqual(1)
  })
})
