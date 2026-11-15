import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { initHub } from '../src/core/hub.js'
import { commitKnowledge } from '../src/core/store.js'
import { createProposal } from '../src/core/store.js'
import { validateHub } from '../src/core/validate.js'
import type { LedgerRecord } from '../src/core/ledger.js'
import type { KnowledgeType } from '../src/core/types.js'

function helpers() {
  return {
    readSequences: (root: string) => ({}),
    writeSequences: () => {},
    appendLedger: (root: string, record: LedgerRecord) => {},
  }
}

function tempHub(): string {
  const root = mkdtempSync(join(tmpdir(), 'amh-validate-'))
  initHub(root)
  return root
}

describe('extraction validation (ADR-0011 gate)', () => {
  it('an empty hub validates clean', () => {
    const report = validateHub(tempHub())
    expect(report.ok).toBe(true)
    expect(report.checked.knowledge).toBe(0)
  })

  it('valid accepted entries pass', () => {
    const root = tempHub()
    commitKnowledge(root, { type: 'knowledge', title: '合格条目', summary: '摘要', scope: { level: 'global' }, tags: [], body: '正文', sourceRefs: ['note:t'] }, helpers())
    const report = validateHub(root)
    expect(report.ok).toBe(true)
    expect(report.checked.knowledge).toBe(1)
  })

  it('a broken frontmatter file is an error (CI gate blocks)', () => {
    const root = tempHub()
    commitKnowledge(root, { type: 'knowledge', title: '正常', summary: '摘要', scope: { level: 'global' }, tags: [], body: 'x', sourceRefs: ['n'] }, helpers())
    writeFileSync(join(root, 'knowledge', 'knowledge', 'BROKEN-000001.md'), '---\nid: BROKEN-000001\nstatus: nonsense\ntype: knowledge\ntitle: x\n---\nbody')
    const report = validateHub(root)
    expect(report.ok).toBe(false)
    expect(report.errors.some((e) => e.file.includes('BROKEN-000001'))).toBe(true)
  })

  it('a duplicate id across files is an error', () => {
    const root = tempHub()
    commitKnowledge(root, { type: 'knowledge', title: '第一条', summary: '摘要', scope: { level: 'global' }, tags: [], body: 'x', sourceRefs: ['n'] }, helpers())
    writeFileSync(join(root, 'knowledge', 'knowledge', 'KNO-000001-dup.md'), '---\nid: KNO-000001\nversion: 1\nstatus: accepted\ntype: knowledge\ntitle: 重复 id\nsummary: s\nscope: global\n---\nbody')
    const report = validateHub(root)
    expect(report.ok).toBe(false)
    expect(report.errors.some((e) => e.message.includes('duplicate id'))).toBe(true)
  })

  it('a proposal whose supersedes target is missing is an error', () => {
    const root = tempHub()
    createProposal(root, { type: 'knowledge', title: '重萃取提案', summary: '摘要', scope: { level: 'global' }, tags: [], body: 'x', sourceRefs: ['n'], supersedes: ['KNO-999999'] }, helpers())
    const report = validateHub(root)
    expect(report.ok).toBe(false)
    expect(report.errors.some((e) => e.message.includes('supersedes target'))).toBe(true)
  })
})
