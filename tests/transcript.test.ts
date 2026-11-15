import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { initHub } from '../src/core/hub.js'
import {
  detectDejaVu,
  indexTranscript,
  readTranscriptIndex,
  rebuildTranscriptIndex,
  TRANSCRIPT_INDEX_FILE,
} from '../src/core/transcript.js'

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'amh-tx-'))
  initHub(root)
  return root
}

describe('day-zero transcript index (deja-vu)', () => {
  it('indexes tokens + preview only; the body stays with the host', () => {
    const root = tempRoot()
    const longText = `${'正文内容滚动'.repeat(60)}END-MARKER-BEYOND-160`
    const record = indexTranscript(root, {
      sessionId: 'session-abc',
      text: longText,
      location: 'host://sessions/session-abc',
    })
    expect(record.tokens).toContain('正文')
    expect(record.tokens).toContain('内容')
    expect(record.preview.length).toBeLessThanOrEqual(160)
    expect(record.location).toContain('session-abc')
    // The index never stores the full body — content beyond 160 chars is absent.
    const raw = readFileSync(join(root, TRANSCRIPT_INDEX_FILE), 'utf8')
    expect(raw).not.toContain('END-MARKER-BEYOND-160')
    expect(raw.split('\n')[0]?.length).toBeLessThan(600)
  })

  it('detectDejaVu surfaces earlier sessions before duplication happens', () => {
    const root = tempRoot()
    indexTranscript(root, {
      sessionId: 'session-lock',
      text: '写锁租约 心跳 超龄回收 fencing token',
      location: 'host://sessions/session-lock',
    })
    indexTranscript(root, {
      sessionId: 'session-npm',
      text: 'npm 发布 占名 placeholder 0.0.1',
      location: 'host://sessions/session-npm',
    })
    const dejaVu = detectDejaVu(root, '写锁租约 fencing 心跳')
    expect(dejaVu.length).toBeGreaterThan(0)
    expect(dejaVu[0]?.sessionId).toBe('session-lock')
    expect(dejaVu.some((hit) => hit.sessionId === 'session-npm')).toBe(false)
  })

  it('unrelated queries return nothing (conservative threshold)', () => {
    const root = tempRoot()
    indexTranscript(root, {
      sessionId: 's1',
      text: '写锁租约讨论',
      location: 'host://s1',
    })
    expect(detectDejaVu(root, '数据库迁移备份恢复')).toHaveLength(0)
  })

  it('rebuild dedups by sessionId keeping the latest record', () => {
    const root = tempRoot()
    indexTranscript(root, { sessionId: 's1', text: '旧内容 alpha', location: 'l1' })
    indexTranscript(root, { sessionId: 's1', text: '新内容 beta', location: 'l2' })
    indexTranscript(root, { sessionId: 's2', text: '另一个会话 gamma', location: 'l3' })
    const records = readTranscriptIndex(root)
    expect(records).toHaveLength(3) // append-only file keeps both s1 lines
    rebuildTranscriptIndex(root, records)
    expect(readTranscriptIndex(root)).toHaveLength(2) // deduped
    expect(existsSync(join(root, TRANSCRIPT_INDEX_FILE))).toBe(true)
  })

  it('empty query returns no deja-vu', () => {
    const root = tempRoot()
    indexTranscript(root, { sessionId: 's1', text: '内容', location: 'l' })
    expect(detectDejaVu(root, '!!!')).toHaveLength(0)
  })
})
