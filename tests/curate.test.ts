import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyzeCurate, jaccard } from '../src/core/curate.js'
import { appendLedger, readSequences, writeSequences } from '../src/core/ledger.js'
import { createProposal, commitKnowledge, listProposals } from '../src/core/store.js'
import { initHub } from '../src/core/hub.js'

function helpers(root: string) {
  return { readSequences, writeSequences, appendLedger: (r: string, rec: Record<string, unknown>) => appendLedger(join(r, 'records', 'ledger.jsonl'), rec as never) }
}

function setup(root: string) {
  initHub(root)
  return helpers(root)
}

describe('jaccard', () => {
  it('is symmetric and 0 for disjoint sets', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(1)
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0)
    expect(jaccard(new Set(), new Set(['a']))).toBe(0)
  })
})

describe('analyzeCurate', () => {
  it('flags a near-identical proposal as duplicate with a supersedes action', () => {
    const root = mkdtempSync(join(tmpdir(), 'amh-cur-'))
    const h = setup(root)
    const committed = commitKnowledge(root, {
      type: 'process', title: '发布流程：打标签触发自动发布', summary: 'git tag 推送触发双包 npm 发布', scope: { level: 'global' }, tags: ['release'], body: 'tag -> actions -> publish', actor: 'test',
    }, h)
    const prop = createProposal(root, {
      type: 'process', title: '发布流程：打标签触发自动发布', summary: 'git tag 推送触发双包 npm 发布的流水线', scope: { level: 'global' }, tags: ['release'], body: 'tag -> actions -> publish via trusted publisher', sourceRefs: ['t'],
    }, h)
    const report = analyzeCurate(root)
    expect(report.duplicates).toHaveLength(1)
    expect(report.duplicates[0].knowledgeId).toBe(committed.id)
    expect(report.duplicates[0].proposalId).toBe(prop.id)
    expect(report.duplicates[0].suggestedAction).toContain('supersedes')
    expect(report.fresh).toHaveLength(0)
  })

  it('flags same-type partial overlap as merge, and proposal twins as merge', () => {
    const root = mkdtempSync(join(tmpdir(), 'amh-cur2-'))
    const h = setup(root)
    commitKnowledge(root, {
      type: 'knowledge', title: '测试环境变量 MEMHUB_ROOT 用法', summary: 'MEMHUB_ROOT 决定 hub 根目录解析顺序', scope: { level: 'global' }, tags: ['env'], body: 'root resolution order env var', actor: 'test',
    }, h)
    createProposal(root, {
      type: 'knowledge', title: 'MEMHUB_ROOT 解析顺序说明', summary: 'MEMHUB_ROOT 决定 hub 根目录的解析顺序规则', scope: { level: 'global' }, tags: ['env'], body: 'resolution order rules', sourceRefs: ['t'],
    }, h)
    const coffee = createProposal(root, {
      type: 'process', title: '完全无关的新流程条目', summary: '关于咖啡机保养周期的零散记录', scope: { level: 'global' }, tags: [], body: 'unrelated coffee machine', sourceRefs: ['t'],
    }, h)
    const report = analyzeCurate(root)
    expect(report.merges.length).toBeGreaterThanOrEqual(1)
    expect(report.fresh.some((r) => r.proposalId === coffee.id)).toBe(true)
  })

  it('marks an unverified aging decision as an aging review candidate', () => {
    const root = mkdtempSync(join(tmpdir(), 'amh-cur3-'))
    const h = setup(root)
    const entry = commitKnowledge(root, {
      type: 'decision', title: '数据库选型 PostgreSQL', summary: '主库使用 PostgreSQL 16', scope: { level: 'global' }, tags: ['db'], body: 'choose postgres', actor: 'test',
    }, h)
    // Backdate the entry's frontmatter beyond agingDays. Both created and
    // updated matter: the analyzer trusts `updated ?? created`.
    const back = new Date(Date.now() - 200 * 86_400_000).toISOString()
    const md = readFileSync(entry.path, 'utf8').replace(/created: .*/, `created: ${back}`).replace(/updated: .*/, `updated: ${back}`)
    writeFileSync(entry.path, md, 'utf8')
    const report = analyzeCurate(root, { agingDays: 90 })
    expect(report.aging.some((r) => r.knowledgeId === entry.id)).toBe(true)
  })

  it('writes a persisted report file under reports/ via the CLI', async () => {
    const root = mkdtempSync(join(tmpdir(), 'amh-cur4-'))
    setup(root)
    const { main } = await import('../src/cli.js')
    expect(main(['curate', '--root', root])).toBe(0)
    const files = readdirSync(join(root, 'reports')).filter((f) => f.startsWith('curate-'))
    expect(files).toHaveLength(1)
  })
})
