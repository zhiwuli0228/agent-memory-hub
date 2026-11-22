import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { initHub } from '../src/core/hub.js'
import { appendLedger, ledgerPath, readSequences, writeSequences } from '../src/core/ledger.js'
import { commitKnowledge, commitProposal, createProposal, listEntries, listProposals } from '../src/core/store.js'
import { preflight, preflightIndex } from '../src/core/inject.js'
import { splitFrontmatter } from '../src/core/frontmatter.js'
import { hubSync, personalCommand, publishCommand, type HubFetch, type PublishTransport } from '../src/cli.js'
import { createApiState, handleApi, type ApiState } from '../src/transport/server.js'
import type { LedgerRecord } from '../src/core/ledger.js'

function helpers() {
  return {
    readSequences,
    writeSequences,
    appendLedger: (root: string, record: LedgerRecord) => appendLedger(ledgerPath(root), record),
  }
}

function tempHub(): string {
  const root = mkdtempSync(join(tmpdir(), 'amh-s0-'))
  initHub(root)
  return root
}

/** In-memory central hub behind the HubFetch seam. */
function centralFetch(centralState: ApiState): HubFetch {
  return async (url, init) => {
    const u = new URL(url)
    const body = init?.body !== undefined ? (JSON.parse(init.body) as Record<string, unknown>) : Object.fromEntries(u.searchParams)
    const resp = handleApi(centralState, init?.method ?? 'GET', u.pathname, body)
    return { ok: resp.status < 400, status: resp.status, body: resp.body as Record<string, unknown> }
  }
}

/** Write publish config into hub.yaml so publishCommand uses the http adapter. */
function enablePublish(root: string, endpoint = 'http://outlet.test/api'): void {
  const p = join(root, 'hub.yaml')
  writeFileSync(p, `${readFileSync(p, 'utf8')}\npublish.adapter: http\npublish.endpoint: ${endpoint}\n`, 'utf8')
}

function pendingFiles(root: string): string[] {
  const dir = join(root, 'pending')
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')) : []
}

describe('S0 correctness fixes (decision-analysis F01–F07)', () => {
  it('F01: publish payload never carries private entries — neither all nor by id', async () => {
    const root = tempHub()
    enablePublish(root)
    commitKnowledge(root, { type: 'knowledge', title: '公开条目', summary: 's', scope: { level: 'global' }, tags: [], body: 'x', sourceRefs: ['n'] }, helpers())
    const priv = commitKnowledge(root, { type: 'knowledge', title: '私有条目', summary: 's', scope: { level: 'private' }, tags: [], body: 'secret', sourceRefs: ['n'] }, helpers())
    const sent: string[] = []
    const transport: PublishTransport = async (_url, init) => {
      sent.push(init.body)
      return { ok: true, status: 200, body: 'ok' }
    }
    // Default-all publish: only the public entry goes out.
    const all = await publishCommand(root, [], transport)
    expect(all.ok).toBe(true)
    expect(sent).toHaveLength(1)
    const payload = JSON.parse(sent[0] ?? '{}') as { entries: Array<{ id: string; title: string }> }
    expect(payload.entries.map((e) => e.title)).toEqual(['公开条目'])
    // Explicit-id publish of a private id: rejected, never silently delivered.
    const byId = await publishCommand(root, [priv.id], transport)
    expect(byId.ok).toBe(false)
    expect(String(byId.error)).toContain(priv.id)
    expect(sent).toHaveLength(1) // nothing extra delivered
  })

  it('F03: pull with a partial failure does NOT advance the watermark', async () => {
    const localRoot = tempHub()
    const centralRoot = tempHub()
    commitKnowledge(centralRoot, { type: 'knowledge', title: '远端条目A', summary: 's', scope: { level: 'global' }, tags: [], body: 'x', sourceRefs: ['n'] }, helpers())
    const centralState = createApiState(centralRoot, undefined)
    const good = centralFetch(centralState)
    // First pull fails on EVERY detail fetch (list succeeds). The watermark
    // must stay put so a retry re-fetches the same window.
    const failing: HubFetch = async (url, init) => {
      if (url.includes('/api/entries/')) return { ok: false, status: 500, body: {} }
      return good(url, init)
    }
    const first = await hubSync(localRoot, 'pull', 'http://central.test', undefined, failing)
    expect(first.ok).toBe(false)
    expect(first.errors.length).toBeGreaterThan(0)
    // Retry with the healthy transport: the entry is still fetched (the
    // failed window was NOT skipped) and applied — never lost.
    const second = await hubSync(localRoot, 'pull', 'http://central.test', undefined, good)
    expect(second.ok).toBe(true)
    expect(second.applied).toHaveLength(1)
  })

  it('F03: push watermark advances even when private entries exist locally', async () => {
    const localRoot = tempHub()
    const centralRoot = tempHub()
    commitKnowledge(localRoot, { type: 'knowledge', title: '共享', summary: 's', scope: { level: 'global' }, tags: [], body: 'x', sourceRefs: ['n'] }, helpers())
    commitKnowledge(localRoot, { type: 'knowledge', title: '私有', summary: 's', scope: { level: 'private' }, tags: [], body: 'y', sourceRefs: ['n'] }, helpers())
    const centralState = createApiState(centralRoot, undefined)
    const fetchImpl = centralFetch(centralState)
    const push = await hubSync(localRoot, 'push', 'http://central.test', undefined, fetchImpl)
    expect(push.ok).toBe(true)
    expect(push.pushed).toBe(1)
    expect(push.privateSkipped).toBe(1)
    // Watermark advanced: a second push sends nothing new.
    const push2 = await hubSync(localRoot, 'push', 'http://central.test', undefined, fetchImpl)
    expect(push2.pushed).toBe(0)
    expect(String(push2.note)).toContain('nothing shareable new')
  })

  it('F05: KEY entries appear in hits AND pack AND audit as one set', () => {
    const root = tempHub()
    commitKnowledge(root, { type: 'knowledge', title: '钉住的关键记忆', summary: '无论意图都要出现', scope: { level: 'global' }, tags: ['key'], body: 'x', sourceRefs: ['n'], actor: 'panel' }, helpers())
    const candidates = ['knowledge/department/knowledge/KNO-000001.md', 'knowledge/global/knowledge/KNO-000001.md']
    const file = candidates.find((f) => existsSync(join(root, f)))
    expect(file).toBeDefined()
    if (file !== undefined) {
      const p = join(root, file)
      writeFileSync(p, readFileSync(p, 'utf8').replace('tags: [key]', 'tags: [key]\nkey: true'), 'utf8')
    }
    const index = preflightIndex(root)
    // Intent totally unrelated — the key must still surface.
    const result = preflight(index, root, 'elsewhere-ws', 'zzz qqq unrelated')
    expect(result.status).toBe('ready')
    expect(result.hits.some((h) => h.id === 'KNO-000001')).toBe(true)
    // F05: the pack is rendered from the SAME surfaced set (contains the key).
    expect(result.pack).toContain('[KNO-000001]')
    // The ledger audit records the same id.
    const ledgerLines = readFileSync(join(root, 'records', 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean)
    const last = JSON.parse(ledgerLines[ledgerLines.length - 1] ?? '{}') as { type: string; hits?: Array<{ id: string }> }
    expect(last.type).toBe('preflight.recorded')
    expect(last.hits?.some((h) => h.id === 'KNO-000001')).toBe(true)
  })

  it('F06: a KEY entry of ANOTHER team does not auto-inject into this viewer', () => {
    const root = tempHub()
    commitKnowledge(root, { type: 'knowledge', title: '别的组的关键', summary: 's', scope: { level: 'domain', domainId: 'team-backend' }, tags: ['key'], body: 'x', sourceRefs: ['n'], actor: 'panel' }, helpers())
    const file = 'knowledge/groups/team-backend/knowledge/KNO-000001.md'
    if (existsSync(join(root, file))) writeFileSync(join(root, file), readFileSync(join(root, file), 'utf8').replace('tags: [key]', 'tags: [key]\nkey: true'), 'utf8')
    const index = preflightIndex(root)
    // Viewer belongs to team-frontend → backend key must NOT inject.
    const result = preflight(index, root, 'ws', 'zzz unrelated', { teamId: 'team-frontend' })
    expect(result.status).toBe('no_match')
    expect(result.hits.some((h) => h.id === 'KNO-000001')).toBe(false)
  })

  it('F07: splitFrontmatter round-trips a body containing a --- horizontal rule', () => {
    const raw = `---
id: KNO-000001
version: 1
---
第一段

---

第二段（markdown 分隔线不应截断正文）
`
    const parsed = splitFrontmatter(raw)
    expect(parsed?.body).toContain('第一段')
    expect(parsed?.body).toContain('第二段（markdown 分隔线不应截断正文）')
  })

  it('F02: personal sync converges two machines and aborts loudly on same-file conflict', () => {
    const bare = mkdtempSync(join(tmpdir(), 'amh-personal-bare-'))
    spawnSync('git', ['init', '--bare', bare], { encoding: 'utf8' })
    const bareUrl = bare.replace(/\\/g, '/')

    // Machine A seeds the personal repo with a private entry.
    const a = tempHub()
    expect(personalCommand(a, 'init', bareUrl).ok).toBe(true)
    commitKnowledge(a, { type: 'knowledge', title: 'A机的私有', summary: 's', scope: { level: 'private' }, tags: [], body: 'a', sourceRefs: ['n'] }, helpers())
    expect(personalCommand(a, 'sync').ok).toBe(true)

    // Machine B adopts A's data FIRST (convergence discipline), then adds its own.
    const b = tempHub()
    expect(personalCommand(b, 'init', bareUrl).ok).toBe(true)
    expect(personalCommand(b, 'sync').ok).toBe(true) // adopts A's KNO-000001
    commitKnowledge(b, { type: 'knowledge', title: 'B机的私有', summary: 's', scope: { level: 'private' }, tags: [], body: 'b', sourceRefs: ['n'] }, helpers())
    expect(personalCommand(b, 'sync').ok).toBe(true)

    // A pulls: now has BOTH entries (converged on one dataset).
    const a2 = personalCommand(a, 'sync')
    expect(a2.ok).toBe(true)
    const aPriv = join(a, 'knowledge-private', 'knowledge')
    expect(existsSync(join(aPriv, 'KNO-000002.md'))).toBe(true)
    expect(readFileSync(join(aPriv, 'KNO-000002.md'), 'utf8')).toContain('B机的私有')

    // Same-file conflict: B edits the SHARED KNO-000001 and pushes; A edits it
    // too. A's next sync must FAIL loudly (stage merge), never overwrite.
    const bFile = join(b, 'knowledge-private', 'knowledge', 'KNO-000001.md')
    writeFileSync(bFile, readFileSync(bFile, 'utf8').replace('title: A机的私有', 'title: A机的私有(B改)'), 'utf8')
    expect(personalCommand(b, 'sync').ok).toBe(true)
    const aFile = join(a, 'knowledge-private', 'knowledge', 'KNO-000001.md')
    writeFileSync(aFile, readFileSync(aFile, 'utf8').replace('title: A机的私有', 'title: A机的私有(A改)'), 'utf8')
    const a3 = personalCommand(a, 'sync')
    expect(a3.ok).toBe(false)
    expect(a3.stage).toBe('merge')
  })

  it('F02: a fresh machine adopting an existing personal repo keeps all entries', () => {
    const bare = mkdtempSync(join(tmpdir(), 'amh-personal-bare2-'))
    spawnSync('git', ['init', '--bare', bare], { encoding: 'utf8' })
    const bareUrl = bare.replace(/\\/g, '/')
    const a = tempHub()
    personalCommand(a, 'init', bareUrl)
    commitKnowledge(a, { type: 'knowledge', title: '已有私有', summary: 's', scope: { level: 'private' }, tags: [], body: 'x', sourceRefs: ['n'] }, helpers())
    expect(personalCommand(a, 'sync').ok).toBe(true)
    // Fresh machine C: no local commits yet — adopts remote wholesale.
    const c = tempHub()
    expect(personalCommand(c, 'init', bareUrl).ok).toBe(true)
    expect(personalCommand(c, 'sync').ok).toBe(true)
    expect(existsSync(join(c, 'knowledge-private', 'knowledge', 'KNO-000001.md'))).toBe(true)
  })

  it('S1: a same-title revision approved through the CLI path bumps the version (no dedup rejection)', () => {
    const root = tempHub()
    const target = commitKnowledge(root, { type: 'process', title: 'SOP', summary: 'v1', scope: { level: 'domain', domainId: 'team-ops' }, tags: [], body: 'v1 body', sourceRefs: ['n'] }, helpers())
    const proposal = createProposal(root, { type: 'process', title: 'SOP', summary: 'v2 补充', scope: { level: 'domain', domainId: 'team-ops' }, tags: [], body: 'v2 body', sourceRefs: ['s1'], supersedes: [target.id] }, helpers())
    // The shared approval implementation is what every surface (CLI/panel/MCP)
    // now uses; the title-dedup guard must NOT fire on a revision.
    const listed = listProposals(root).find((p) => p.id === proposal.id)
    expect(listed).toBeDefined()
    const committed = commitProposal(root, listed as NonNullable<typeof listed>, helpers(), { channel: 'cli-human' })
    expect(committed.knowledgeId).toBe(target.id)
    expect(committed.superseded).toBe(target.id)
    expect(committed.version).toBe(2)
    // Identity stable: no duplicate entry, pending queue drained, body upgraded.
    expect(listEntries(root, { includeSoftRemoved: true }).filter((e) => e.frontmatter.type === 'process')).toHaveLength(1)
    expect(pendingFiles(root)).toHaveLength(0)
    const upgraded = readFileSync(join(root, 'knowledge', 'groups', 'team-ops', 'process', `${target.id}.md`), 'utf8')
    expect(upgraded).toContain('v2 body')
    expect(upgraded).toContain('version: 2')
  })

  it('D06: a stale-base revision is isolated as a dispute, not a silent overwrite', () => {
    const root = tempHub()
    const target = commitKnowledge(root, { type: 'process', title: 'SOP', summary: 'v1', scope: { level: 'domain', domainId: 'team-ops' }, tags: [], body: 'v1', sourceRefs: ['n'] }, helpers())
    const proposal = createProposal(root, { type: 'process', title: 'SOP', summary: 'v2 补充', scope: { level: 'domain', domainId: 'team-ops' }, tags: [], body: 'v2 body', sourceRefs: ['s1'], supersedes: [target.id] }, helpers())
    // The proposal recorded the base version it was written against (v1).
    const listed = listProposals(root).find((p) => p.id === proposal.id) as NonNullable<ReturnType<typeof listProposals>[number]>
    expect(listed.frontmatter.extra['supersedes_base']).toBe(1)
    // Someone ELSE advances the target before approval (concurrent divergence).
    commitKnowledge(root, { id: target.id, type: 'process', title: 'SOP', summary: 'v2 别人的现场证据', scope: { level: 'domain', domainId: 'team-ops' }, tags: [], body: 'v2 别人的', sourceRefs: ['peer'] }, helpers())
    const committed = commitProposal(root, listed, helpers(), { channel: 'cli-human' })
    expect('disputed' in committed && committed.disputed).toBe(true)
    expect(committed.currentVersion).toBe(2)
    expect(committed.baseVersion).toBe(1)
    // Nothing was overwritten: the target keeps the peer's v2.
    const after = readFileSync(join(root, 'knowledge', 'groups', 'team-ops', 'process', `${target.id}.md`), 'utf8')
    expect(after).toContain('v2 别人的')
    expect(after).toContain('version: 2')
    // The proposal stays in the inbox (isolated, awaiting human review).
    expect(pendingFiles(root)).toHaveLength(1)
    // The ledger explains the isolation.
    const ledgerLines = readFileSync(join(root, 'records', 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean)
    expect(ledgerLines.some((l) => l.includes('"dispute.raised"') && l.includes(target.id))).toBe(true)
  })

  it('D06: explicit override commits the stale revision and records the audit', () => {
    const root = tempHub()
    const target = commitKnowledge(root, { type: 'process', title: 'SOP', summary: 'v1', scope: { level: 'domain', domainId: 'team-ops' }, tags: [], body: 'v1', sourceRefs: ['n'] }, helpers())
    const proposal = createProposal(root, { type: 'process', title: 'SOP', summary: 'v2 补充', scope: { level: 'domain', domainId: 'team-ops' }, tags: [], body: 'v2 body', sourceRefs: ['s1'], supersedes: [target.id] }, helpers())
    const listed = listProposals(root).find((p) => p.id === proposal.id) as NonNullable<ReturnType<typeof listProposals>[number]>
    commitKnowledge(root, { id: target.id, type: 'process', title: 'SOP', summary: 'v2 别人的', scope: { level: 'domain', domainId: 'team-ops' }, tags: [], body: 'v2 别人的', sourceRefs: ['peer'] }, helpers())
    const committed = commitProposal(root, listed, helpers(), { channel: 'cli-human', override: true })
    expect('disputed' in committed && committed.disputed).toBe(false)
    expect(committed.superseded).toBe(target.id)
    expect(committed.version).toBe(3)
    const ledgerLines = readFileSync(join(root, 'records', 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean)
    expect(ledgerLines.some((l) => l.includes('"dispute.overridden"'))).toBe(true)
    expect(pendingFiles(root)).toHaveLength(0)
  })
})
