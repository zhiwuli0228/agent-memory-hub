import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { initHub } from '../src/core/hub.js'
import { appendJournal, readJournal, trimJournal } from '../src/core/journal.js'
import { listEntries } from '../src/core/store.js'

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'amh-journal-'))
  initHub(root)
  return root
}

describe('journal (episodic layer)', () => {
  it('appends per-day JSONL files and reads them back', () => {
    const root = tempRoot()
    appendJournal(root, { sessionId: 's1', text: '讨论了写锁租约的细节' })
    appendJournal(root, { sessionId: 's2', text: '第二次对话' })
    appendJournal(root, { ts: '2026-11-14T10:00:00+08:00', sessionId: 's0', text: '昨天的事' })
    const days = readJournal(root)
    expect(days).toHaveLength(3)
    const yesterday = readJournal(root, '2026-11-14')
    expect(yesterday).toHaveLength(1)
    expect(yesterday[0]?.sessionId).toBe('s0')
    expect(existsSync(join(root, 'journal', '2026-11-14.jsonl'))).toBe(true)
  })

  it('journal NEVER leaks into knowledge (auto-capture ≠ auto-write)', () => {
    const root = tempRoot()
    appendJournal(root, { text: '这段话看起来像知识，但只是情景记录：写锁用租约' })
    expect(listEntries(root)).toHaveLength(0)
  })

  it('trimJournal deletes only days older than keepDays', () => {
    const root = tempRoot()
    appendJournal(root, { ts: '2026-11-01T10:00:00+08:00', text: '老的' })
    appendJournal(root, { ts: '2026-11-14T10:00:00+08:00', text: '近的' })
    const removed = trimJournal(root, 7, '2026-11-15T00:00:00+08:00')
    expect(removed).toBe(1)
    expect(readJournal(root, '2026-11-01')).toHaveLength(0)
    expect(readJournal(root, '2026-11-14')).toHaveLength(1)
  })

  it('malformed lines are skipped silently (journal is disposable)', () => {
    const root = tempRoot()
    appendJournal(root, { text: 'good' })
    const dir = join(root, 'journal')
    const file = readdirSync(dir).find((f) => f.endsWith('.jsonl')) ?? ''
    writeFileSync(join(dir, file), readFileSync(join(dir, file), 'utf8') + '{broken\n', 'utf8')
    expect(readJournal(root).length).toBe(1)
  })
})
