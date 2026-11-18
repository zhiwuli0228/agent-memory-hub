import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { commitKnowledge, createProposal, listEntries, listProposals } from '../src/core/store.js'
import { appendLedger, readSequences, writeSequences } from '../src/core/ledger.js'
import { initHub } from '../src/core/hub.js'
import { buildIndex, search } from '../src/core/search.js'
import { analyzeCurate } from '../src/core/curate.js'
import { handleApi } from '../src/transport/server.js'

const DOMAINS = 20
const ENTRIES_PER_DOMAIN = 50 // 1000-entry central hub (one year of a 150-person org)
const PROPOSERS = 150 // one pending proposal each — daily triage burst

function helpers(root: string) {
  return { readSequences, writeSequences, appendLedger: (r: string, rec: Record<string, unknown>) => appendLedger(join(r, 'records', 'ledger.jsonl'), rec as never) }
}

describe('ADR-0021 large-team scale (local simulation)', () => {
  const root = mkdtempSync(join(tmpdir(), 'amh-sim150-'))
  const h = helpers(root)
  initHub(root)

  it('builds and searches a 1000-entry / 20-domain hub within interactive latency', () => {
    const t0 = Date.now()
    for (let d = 0; d < DOMAINS; d += 1) {
      for (let i = 0; i < ENTRIES_PER_DOMAIN; i += 1) {
        commitKnowledge(root, {
          type: 'knowledge',
          title: `团队${d}的流程条目${i}：环境配置约定`,
          summary: `团队${d}第${i}条关于部署环境配置的团队约定与踩坑记录`,
          scope: { level: 'domain', domainId: `team-${d}` },
          tags: [`team-${d}`],
          body: `部署环境配置约定正文 ${d}-${i}`,
          actor: 'sim',
        }, h)
      }
    }
    const writeMs = Date.now() - t0
    const t1 = Date.now()
    const index = buildIndex(root, () => new Date().toISOString())
    const buildMs = Date.now() - t1
    expect(index.docs.size).toBe(DOMAINS * ENTRIES_PER_DOMAIN)

    const t2 = Date.now()
    let hits = 0
    for (let q = 0; q < 100; q += 1) {
      hits += search(index, `团队${q % DOMAINS} 部署配置`, { teamId: `team-${q % DOMAINS}` }).length
    }
    const queryMs = Date.now() - t2
    expect(hits).toBeGreaterThan(100)
    // Interactive latencies on a 150-person org's yearly corpus.
    expect(buildMs).toBeLessThan(10_000)
    expect(queryMs / 100).toBeLessThan(50) // avg < 50ms per scoped search
    console.log(`[sim150] write ${writeMs}ms | index ${buildMs}ms | avg query ${queryMs / 100}ms`)
  })

  it('curate over 1000 entries + 150 daily proposals stays in interactive range', () => {
    for (let p = 0; p < PROPOSERS; p += 1) {
      createProposal(root, {
        type: 'process',
        title: `成员${p}的每日记录：环境配置${p % DOMAINS}`,
        summary: `成员${p}关于团队${p % DOMAINS}部署配置的今日记录`,
        scope: { level: 'domain', domainId: `team-${p % DOMAINS}` },
        tags: [],
        body: `今日记录正文 ${p}`,
        sourceRefs: [`member-${p}`],
      }, h)
    }
    expect(listProposals(root).length).toBe(PROPOSERS)
    const t0 = Date.now()
    const report = analyzeCurate(root, { agingDays: 3650 }) // disable staleness noise for the sim
    const curateMs = Date.now() - t0
    expect(report.proposalsAnalyzed).toBe(PROPOSERS)
    expect(report.entriesAnalyzed).toBe(DOMAINS * ENTRIES_PER_DOMAIN)
    expect(curateMs).toBeLessThan(30_000)
    console.log(`[sim150] curate (150x1000 comparisons) ${curateMs}ms`)
  })

  it('inbox groups the burst by domain for triage', () => {
    const state = { hubRoot: root, index: buildIndex(root, () => new Date().toISOString()), metrics: {}, workspace: { workspaceId: 'sim', name: 'sim', path: root, exact: false } } as never
    const r = handleApi(state, 'GET', '/api/inbox').body as { total: number; groups: Record<string, number> }
    expect(r.total).toBe(PROPOSERS)
    expect(Object.keys(r.groups).length).toBe(DOMAINS)
    const one = handleApi(state, 'GET', '/api/inbox', { domain: 'team-3' }).body as { proposals: unknown[] }
    expect(one.proposals.length).toBeGreaterThan(0)
    expect(one.proposals.length).toBeLessThan(PROPOSERS / (DOMAINS / 2))
  })

  it('domain token binds pushes: cross-domain 403, unscoped stamped, admin free', () => {
    const state = { hubRoot: root, index: buildIndex(root, () => new Date().toISOString()), metrics: {}, workspace: { workspaceId: 'sim', name: 'sim', path: root, exact: false } } as never
    const mk = (scope: unknown) => ({ type: 'knowledge', title: `跨域测试${Math.random()}`, summary: 's', tags: [], body: 'b', scope, sourceRefs: ['t'] })
    const cross = handleApi(state, 'POST', '/api/propose', mk({ level: 'domain', domainId: 'team-9' }), { role: 'domain', domainId: 'team-1' })
    expect(cross.status).toBe(403)
    const stamped = handleApi(state, 'POST', '/api/propose', mk({ level: 'global' }), { role: 'domain', domainId: 'team-1' })
    expect(stamped.status).toBe(200)
    const admin = handleApi(state, 'POST', '/api/propose', mk({ level: 'domain', domainId: 'team-9' }), { role: 'admin', domainId: undefined })
    expect(admin.status).toBe(200)
  })
})
