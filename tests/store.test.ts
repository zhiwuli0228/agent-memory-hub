import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendLedger, ledgerPath, readLedger, readSequences, writeSequences } from '../src/core/ledger.js'
import {
  commitKnowledge,
  createProposal,
  deprecateEntry,
  findTitleConflict,
  getEntry,
  hardDeleteEntry,
  listEntries,
  listProposals,
} from '../src/core/store.js'
import type { LedgerRecord } from '../src/core/ledger.js'
import type { KnowledgeScope } from '../src/core/types.js'

const scope: KnowledgeScope = { level: 'project', workspaceId: 'w1' }

function tempHub(): { root: string; ledgerRecords: LedgerRecord[] } {
  const root = mkdtempSync(join(tmpdir(), 'amh-store-'))
  const ledgerRecords: LedgerRecord[] = []
  const helpers = {
    readSequences,
    writeSequences,
    appendLedger: (r: string, record: LedgerRecord) => {
      appendLedger(ledgerPath(r), record)
      ledgerRecords.push(record)
    },
  }
  return { root, ledgerRecords, helpers }
}

const baseInput = {
  type: 'decision' as const,
  title: '写锁改为租约',
  summary: '挂死写者按心跳超龄自动回收。',
  scope,
  tags: ['lock'],
  body: '租约语义正文。',
  sourceRefs: ['session:t1#1-10'],
}

describe('store: create + ledger + sequences', () => {
  it('creates an accepted entry with padded id and a ledger approve record', () => {
    const { root, ledgerRecords, helpers } = tempHub()
    const result = commitKnowledge(root, baseInput, helpers)
    expect(result.id).toBe('DEC-000001')
    expect(result.version).toBe(1)
    const entry = getEntry(root, result.id)
    expect(entry.frontmatter.status).toBe('accepted')
    expect(entry.frontmatter.scope).toEqual(scope)
    expect(entry.softRemoved).toBe(false)
    expect(ledgerRecords).toHaveLength(1)
    expect(ledgerRecords[0]?.action).toBe('approve')
    expect(readSequences(root)['DEC']).toBe(1)
  })

  it('rejects a second entry with the same title (conflict freeze at the store boundary)', () => {
    const { root, helpers } = tempHub()
    commitKnowledge(root, baseInput, helpers)
    expect(() => commitKnowledge(root, { ...baseInput, title: '写锁改为租约' }, helpers)).toThrowError(
      /same title exists/,
    )
    const conflict = findTitleConflict(root, '写锁改为租约')
    expect(conflict?.frontmatter.id).toBe('DEC-000001')
  })

  it('updates snapshot the previous version into history and bump the ledger', () => {
    const { root, ledgerRecords, helpers } = tempHub()
    const first = commitKnowledge(root, baseInput, helpers)
    const second = commitKnowledge(
      root,
      { ...baseInput, id: first.id, title: '写锁租约 v2', body: '更新后的正文。' },
      helpers,
    )
    expect(second.version).toBe(2)
    const historyDirPath = join(root, 'history', 'decision')
    expect(readdirSync(historyDirPath)).toContain('DEC-000001@v1.md')
    expect(getEntry(root, first.id).frontmatter.title).toBe('写锁租约 v2')
    expect(ledgerRecords.at(-1)?.action).toBe('update')
  })

  it('deprecate marks soft-removed (excluded from default listing)', () => {
    const { root, helpers } = tempHub()
    const created = commitKnowledge(root, baseInput, helpers)
    deprecateEntry(root, created.id, '过时方案', helpers)
    expect(getEntry(root, created.id).softRemoved).toBe(true)
    expect(listEntries(root)).toHaveLength(0)
    expect(listEntries(root, { includeSoftRemoved: true })).toHaveLength(1)
  })

  it('hard delete removes the file but keeps the ledger record', () => {
    const { root, ledgerRecords, helpers } = tempHub()
    const created = commitKnowledge(root, baseInput, helpers)
    hardDeleteEntry(root, created.id, 'GDPR request', helpers)
    expect(existsSync(created.path)).toBe(false)
    expect(ledgerRecords.at(-1)?.action).toBe('delete')
    expect(readLedger(ledgerPath(root)).at(-1)?.note).toBe('GDPR request')
  })

  it('expires_at past the clock makes the entry soft-removed', () => {
    const { root, helpers } = tempHub()
    commitKnowledge(root, { ...baseInput, expiresAt: '2000-01-01T00:00:00Z' }, helpers)
    expect(listEntries(root)).toHaveLength(0)
    const all = listEntries(root, { includeSoftRemoved: true })
    expect(all[0]?.softRemoved).toBe(true)
  })
})

describe('store: pending proposals', () => {
  it('createProposal writes pending/PRO with source refs and a propose ledger record', () => {
    const { root, ledgerRecords, helpers } = tempHub()
    const proposal = createProposal(root, { ...baseInput, sourceRefs: ['file:a.md'] }, helpers)
    expect(proposal.id).toBe('PRO-000001')
    expect(existsSync(join(root, 'pending', 'PRO-000001.md'))).toBe(true)
    const listed = listProposals(root)
    expect(listed).toHaveLength(1)
    expect(listed[0]?.frontmatter.status).toBe('candidate')
    expect(listed[0]?.frontmatter.extra['source_refs']).toBe('file:a.md')
    expect(ledgerRecords[0]?.action).toBe('propose')
  })

  it('proposal ids and knowledge ids use independent sequences', () => {
    const { root, helpers } = tempHub()
    createProposal(root, { ...baseInput, sourceRefs: ['note:x'] }, helpers)
    const entry = commitKnowledge(root, baseInput, helpers)
    expect(entry.id).toBe('DEC-000001')
    const second = createProposal(root, { ...baseInput, sourceRefs: ['note:y'] }, helpers)
    expect(second.id).toBe('PRO-000002')
  })
})
