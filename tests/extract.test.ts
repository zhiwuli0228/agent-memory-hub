import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendLedger, ledgerPath } from '../src/core/ledger.js'
import { buildExtractionMaterial, readExtractState, writeExtractState } from '../src/core/extract.js'
import { commitKnowledge, createProposal } from '../src/core/store.js'
import { initHub } from '../src/core/hub.js'
import type { LedgerRecord } from '../src/core/ledger.js'

function helpers() {
  return {
    readSequences: () => ({}),
    writeSequences: () => {},
    appendLedger: (root: string, record: LedgerRecord) => appendLedger(ledgerPath(root), record),
  }
}

describe('extraction protocol (trigger-agnostic, ADR-0011)', () => {
  it('material lists ledger events since the watermark plus current entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'amh-extract-'))
    initHub(root)
    writeExtractState(root, '2026-11-01T00:00:00.000Z')
    commitKnowledge(root, { type: 'knowledge', title: '旧条目', summary: '已萃取', scope: { level: 'global' }, tags: [], body: 'x', sourceRefs: ['n'], actor: 'human' }, helpers())
    helpers().appendLedger(root, { ts: '2026-11-10T08:00:00.000Z', actor: 'model', action: 'propose', id: 'PRO-000001' })
    helpers().appendLedger(root, { ts: '2026-11-02T08:00:00.000Z', actor: 'human', action: 'approve', id: 'KNO-000001' })
    const material = buildExtractionMaterial(root)
    // Watermark is 2026-11-01: both manual events are after it, plus the
    // commit's own approve event (ts=now) — all included.
    expect(material.ledgerEvents.length).toBeGreaterThanOrEqual(2)
    expect(material.ledgerEvents.some((e) => e.id === 'PRO-000001')).toBe(true)
    expect(material.ledgerEvents.some((e) => e.ts > '2026-11-01')).toBe(true)
    expect(material.since).toBe('2026-11-01T00:00:00.000Z')
    expect(material.entries.some((e) => e.title === '旧条目')).toBe(true)
    expect(material.instruction).toContain('supersedes')
  })

  it('--since overrides the watermark; events before it are excluded', () => {
    const root = mkdtempSync(join(tmpdir(), 'amh-extract-'))
    initHub(root)
    helpers().appendLedger(root, { ts: '2026-11-05T08:00:00.000Z', action: 'approve', id: 'KNO-000001' })
    helpers().appendLedger(root, { ts: '2026-11-09T08:00:00.000Z', action: 'propose', id: 'PRO-000002' })
    const material = buildExtractionMaterial(root, '2026-11-06T00:00:00.000Z')
    expect(material.since).toBe('2026-11-06T00:00:00.000Z')
    expect(material.ledgerEvents).toHaveLength(1)
    expect(material.ledgerEvents[0]?.id).toBe('PRO-000002')
  })

  it('done advances the watermark and counts runs', () => {
    const root = mkdtempSync(join(tmpdir(), 'amh-extract-'))
    initHub(root)
    writeExtractState(root, '2026-11-10T00:00:00.000Z')
    writeExtractState(root, '2026-11-11T00:00:00.000Z')
    const state = readExtractState(root)
    expect(state.lastExtractedAt).toBe('2026-11-11T00:00:00.000Z')
    expect(state.extractionCount).toBe(2)
    // The persisted file is part of records/ — included in sync push.
    expect(readFileSync(join(root, 'records', 'extract-state.json'), 'utf8')).toContain('extractionCount')
  })

  it('pending titles surface so the agent does not re-propose them', () => {
    const root = mkdtempSync(join(tmpdir(), 'amh-extract-'))
    initHub(root)
    createProposal(root, { type: 'knowledge', title: '已在队列的提案', summary: 's', scope: { level: 'global' }, tags: [], body: 'x', sourceRefs: ['n'] }, helpers())
    const material = buildExtractionMaterial(root)
    expect(material.pendingTitles).toContain('已在队列的提案')
  })
})
