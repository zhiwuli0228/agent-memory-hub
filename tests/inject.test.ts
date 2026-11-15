import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { initHub } from '../src/core/hub.js'
import { appendLedger, ledgerPath, readLedger, readSequences, writeSequences } from '../src/core/ledger.js'
import { estimateTokens, preflight, preflightIndex, renderPack } from '../src/core/inject.js'
import { commitKnowledge } from '../src/core/store.js'
import type { LedgerRecord } from '../src/core/ledger.js'
import type { KnowledgeScope } from '../src/core/types.js'

const ws: KnowledgeScope = { level: 'project', workspaceId: 'acme-app' }
const glob: KnowledgeScope = { level: 'global' }

function ledgerHelpers(): {
  readSequences: (root: string) => Record<string, number>
  writeSequences: (root: string, seq: Record<string, number>) => void
  appendLedger: (root: string, record: LedgerRecord) => void
} {
  return {
    readSequences,
    writeSequences,
    appendLedger: (root, record) => appendLedger(ledgerPath(root), record),
  }
}

function seededRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'amh-inject-'))
  initHub(root)
  commitKnowledge(
    root,
    {
      type: 'decision',
      title: '降噪用 top-k 截断',
      summary: 'min_score 无区分度，top-3 达标。',
      scope: ws,
      tags: ['search'],
      body: '回放实验结论正文。',
      sourceRefs: ['file:replay'],
    },
    ledgerHelpers(),
  )
  commitKnowledge(
    root,
    {
      type: 'constraint',
      title: '人批准才能进 knowledge',
      summary: '模型永远不能自批。',
      scope: glob,
      tags: ['invariant'],
      body: '失败关闭正文。',
      sourceRefs: ['file:AGENTS.md'],
    },
    ledgerHelpers(),
  )
  return root
}

describe('preflight / injection', () => {
  it('L0 pack is compact: id + title + abstract, within a token budget', () => {
    const root = seededRoot()
    const index = preflightIndex(root)
    const result = preflight(index, root, 'acme-app', '降噪 截断')
    expect(result.status).toBe('ready')
    expect(result.pack).toBeDefined()
    expect(result.pack).toMatch(/^\[DEC-000001\] 降噪用 top-k 截断 — /)
    expect(result.tokens).toBeGreaterThan(0)
    expect(result.tokens).toBeLessThan(60) // one line — far below the ~250 budget
  })

  it('top-3 default limit caps the pack size (replay-calibrated)', () => {
    const root = seededRoot()
    const index = preflightIndex(root)
    const result = preflight(index, root, 'acme-app', 'knowledge 批准 模型 决策 截断')
    expect(result.hits.length).toBeLessThanOrEqual(3)
  })

  it('no_match when nothing is relevant — host injects nothing', () => {
    const root = seededRoot()
    const index = preflightIndex(root)
    const result = preflight(index, root, 'acme-app', 'zzz qqq unrelated')
    expect(result.status).toBe('no_match')
    expect(result.pack).toBeUndefined()
    expect(result.tokens).toBe(0)
  })

  it('records a predecessor-shaped preflight.recorded event in the ledger', () => {
    const root = seededRoot()
    const index = preflightIndex(root)
    preflight(index, root, 'acme-app', '降噪')
    const events = readLedger(join(root, 'records', 'ledger.jsonl'))
    const event = events.find((e) => e['type'] === 'preflight.recorded') as
      | { preflightId: string; status: string; hits: Array<{ id: string }>; tokens: number; intent: string }
      | undefined
    expect(event).toBeDefined()
    expect(event?.preflightId).toMatch(/^PF-/)
    expect(event?.status).toBe('ready')
    expect(event?.hits[0]?.id).toBe('DEC-000001')
    expect(event?.intent).toBe('降噪')
  })

  it('estimateTokens: CJK ≈ 1/char, ASCII words ≈ 1.3', () => {
    expect(estimateTokens('写锁租约')).toBe(4)
    expect(estimateTokens('lock lease')).toBe(3) // 2 words * 1.3 -> ceil 3
    expect(estimateTokens('写锁 lock')).toBe(4) // 2 + ceil(1.3) -> 2+2
  })

  it('renderPack is one line per hit', () => {
    const root = seededRoot()
    const index = preflightIndex(root)
    const result = preflight(index, root, 'acme-app', 'knowledge 批准 模型 决策 截断', { limit: 3 })
    const lines = renderPack(result.hits).split('\n')
    expect(lines.length).toBe(result.hits.length)
  })
})
