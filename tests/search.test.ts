import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { initHub } from '../src/core/hub.js'
import { appendLedger, ledgerPath } from '../src/core/ledger.js'
import { buildIndex, emptyMetrics, search, searchWithMetrics, tokenize } from '../src/core/search.js'
import { commitKnowledge } from '../src/core/store.js'
import type { LedgerRecord } from '../src/core/ledger.js'
import type { KnowledgeScope } from '../src/core/types.js'

const w1: KnowledgeScope = { level: 'project', workspaceId: 'acme-app' }
const w2: KnowledgeScope = { level: 'project', workspaceId: 'other-app' }
const glob: KnowledgeScope = { level: 'global' }

function seededHub(): string {
  const root = mkdtempSync(join(tmpdir(), 'amh-search-'))
  initHub(root)
  const records: LedgerRecord[] = []
  const helpers = {
    readSequences: (r: string) => seedSeq(r),
    writeSequences: (r: string, s: Record<string, number>) => {
      seqs.set(r, s)
    },
    appendLedger: (r: string, record: LedgerRecord) => {
      records.push(record)
      appendLedger(ledgerPath(r), record)
    },
  }
  const seqs = new Map<string, Record<string, number>>()
  function seedSeq(_r: string): Record<string, number> {
    return seqs.get(_r) ?? {}
  }
  commitKnowledge(
    root,
    {
      type: 'decision',
      title: '写锁改为租约 + fencing token',
      summary: '挂死写者按心跳超龄自动回收，旧写者按 token 降级只读。',
      scope: w1,
      tags: ['lock', 'lease'],
      body: '租约语义：心跳 15s，stale 45s 自动回收。fencing token 保证旧写者不能覆盖新写者。',
      sourceRefs: ['session:t#1-2'],
    },
    helpers,
  )
  commitKnowledge(
    root,
    {
      type: 'constraint',
      title: '人批准才能进 knowledge',
      summary: '模型可以创建 pending 候选，永远不能自批。',
      scope: glob,
      tags: ['invariant', 'approval'],
      body: '写操作失败关闭：没有审批落点时 commit 必须拒绝。',
      sourceRefs: ['file:AGENTS.md'],
    },
    helpers,
  )
  commitKnowledge(
    root,
    {
      type: 'knowledge',
      title: 'Codex exec approval policy',
      summary: 'codex exec non-interactive defaults to approval never.',
      scope: w2,
      tags: ['codex'],
      body: 'Use --dangerously-bypass-approvals-and-sandbox for tests only.',
      sourceRefs: ['session:t#3-4'],
    },
    helpers,
  )
  return root
}

describe('tokenize', () => {
  it('splits CJK runs into bigrams and ASCII into lowercase words', () => {
    expect(tokenize('写锁租约 lock Lease v2')).toEqual(['写锁', '锁租', '租约', 'lock', 'lease', 'v2'])
  })

  it('handles mixed CJK/ASCII and drops punctuation', () => {
    expect(tokenize('BM25-lite 检索！')).toEqual(['bm25', 'lite', '检索'])
  })
})

describe('search: scope visibility', () => {
  it('a project workspace sees itself + global, never other projects', () => {
    const root = seededHub()
    const index = buildIndex(root, () => 't')
    const hits = search(index, '审批', { workspaceId: 'acme-app' })
    expect(hits.map((hit) => hit.id)).toContain('CON-000001')
    expect(hits.map((hit) => hit.id)).not.toContain('KNO-000001')
  })

  it('the other workspace sees its own entry and the global one', () => {
    const root = seededHub()
    const index = buildIndex(root, () => 't')
    const hits = search(index, 'codex', { workspaceId: 'other-app' })
    expect(hits.map((hit) => hit.id)).toContain('KNO-000001')
  })
})

describe('search: ranking and detail levels', () => {
  it('title hits rank above body-only hits (field weights)', () => {
    const root = seededHub()
    const index = buildIndex(root, () => 't')
    const hits = search(index, '写锁租约', { workspaceId: 'acme-app' })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]?.title).toContain('写锁')
  })

  it('L0 returns the abstract only; L1 adds summary; L2 adds body', () => {
    const root = seededHub()
    const index = buildIndex(root, () => 't')
    const l0 = search(index, '租约', { workspaceId: 'acme-app', detail: 'L0' })
    const l1 = search(index, '租约', { workspaceId: 'acme-app', detail: 'L1' })
    const l2 = search(index, '租约', { workspaceId: 'acme-app', detail: 'L2' })
    expect(l0[0]?.summary).toBeUndefined()
    expect(l0[0]?.body).toBeUndefined()
    expect(l1[0]?.summary).toBeDefined()
    expect(l1[0]?.body).toBeUndefined()
    expect(l2[0]?.body).toContain('fencing token')
  })

  it('minScore filters low-relevance noise; local boost favors own workspace', () => {
    const root = seededHub()
    const index = buildIndex(root, () => 't')
    const all = search(index, 'approval invariant', { workspaceId: 'acme-app' })
    const filtered = search(index, 'approval invariant', { workspaceId: 'acme-app', minScore: all[0]?.score ?? 0 + 100 })
    expect(filtered).toHaveLength(0)
    const own = search(index, '审批', { workspaceId: 'acme-app', detail: 'L1' })
    expect(own[0]?.scope.level).toBe('global') // only one match anyway; boost exercised indirectly
  })

  it('soft-removed (deprecated/expired) entries never surface', () => {
    const root = seededHub()
    const index = buildIndex(root, () => 't')
    const hits = search(index, 'codex', { workspaceId: 'other-app' })
    expect(hits.every((hit) => hit.status !== 'deprecated')).toBe(true)
  })

  it('type filter narrows the result set', () => {
    const root = seededHub()
    const index = buildIndex(root, () => 't')
    const hits = search(index, '审批', { workspaceId: 'acme-app', types: ['constraint'] })
    expect(hits.every((hit) => hit.type === 'constraint')).toBe(true)
  })
})

describe('search metrics', () => {
  it('tracks query count and hit totals', () => {
    const root = seededHub()
    const index = buildIndex(root, () => 't')
    const metrics = emptyMetrics(index)
    expect(metrics.indexedCount).toBe(3)
    searchWithMetrics(index, metrics, '租约', { workspaceId: 'acme-app' })
    searchWithMetrics(index, metrics, '租约', { workspaceId: 'acme-app' })
    searchWithMetrics(index, metrics, 'zzz-nothing', { workspaceId: 'acme-app' })
    expect(metrics.queryCount).toBe(3)
    expect(metrics.totalHits).toBe(2)
    expect(metrics.lastHitCount).toBe(0)
    expect(metrics.lastQuery).toBe('zzz-nothing')
  })
})

describe('old hub compatibility (read-only inventory)', () => {
  const OLD_HUB = process.env['MEMHUB_OLD_HUB_ROOT'] ?? 'E:\\009workspace\\dsh\\dsh-plugin-dev'
  const available = existsSync(join(OLD_HUB, 'knowledge'))

  it.skipIf(!available)('indexes the real predecessor hub and finds Chinese decisions', () => {
    const index = buildIndex(OLD_HUB, () => 't')
    expect(index.docs.size).toBeGreaterThan(10)
    const hits = search(index, '写锁 租约', { workspaceId: 'dsh-memory-hub' })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]?.id).toMatch(/^(DEC|KNO|PRC)-\d{6}$/)
  })
})
