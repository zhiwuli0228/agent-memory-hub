import { describe, expect, it } from 'vitest'
import { parseKnowledgeFile, splitFrontmatter } from '../src/core/frontmatter.js'

/**
 * Format contract tests — lock the hub-directory knowledge format that this
 * repo shares with dsh-memory-hub (zero-migration compatibility). The sample
 * below mirrors what dsh-memory-hub actually writes; extend only with real
 * samples from a live hub, never invent new syntax here.
 */

const SAMPLE = `---
id: DEC-000001
version: 2
type: decision
status: accepted
title: 写锁改为租约 + fencing token
summary: 挂死写者按心跳超龄自动回收，旧写者按 token 降级只读。
scope:
  level: project
  workspaceId: dsh-memory-hub
tags: [lock, lease, fencing]
created: 2026-10-20T10:00:00+08:00
updated: 2026-11-01T09:30:00+08:00
future_field: preserved-verbatim
---

# 正文

租约语义正文内容。
`

describe('splitFrontmatter', () => {
  it('splits a leading fenced block from the body', () => {
    const split = splitFrontmatter(SAMPLE)
    expect(split).not.toBeNull()
    expect(split?.yaml).toContain('id: DEC-000001')
    expect(split?.body).toContain('# 正文')
    expect(split?.body).not.toContain('id: DEC-000001')
  })

  it('returns null when the file does not start with a frontmatter block', () => {
    expect(splitFrontmatter('just text\n')).toBeNull()
    expect(splitFrontmatter('---\nno closing')).toBeNull()
  })
})

describe('parseKnowledgeFrontmatter (contract)', () => {
  it('parses the full contract surface of a real sample', () => {
    const { frontmatter } = parseKnowledgeFile(SAMPLE)
    expect(frontmatter.id).toBe('DEC-000001')
    expect(frontmatter.version).toBe(2)
    expect(frontmatter.type).toBe('decision')
    expect(frontmatter.status).toBe('accepted')
    expect(frontmatter.title).toBe('写锁改为租约 + fencing token')
    expect(frontmatter.scope).toEqual({ level: 'project', workspaceId: 'dsh-memory-hub' })
    expect(frontmatter.tags).toEqual(['lock', 'lease', 'fencing'])
    expect(frontmatter.created).toBe('2026-10-20T10:00:00+08:00')
  })

  it('preserves unknown frontmatter keys verbatim (forward compatibility)', () => {
    const { frontmatter } = parseKnowledgeFile(SAMPLE)
    expect(frontmatter.extra['future_field']).toBe('preserved-verbatim')
  })

  it('parses global and domain scopes', () => {
    const global = parseKnowledgeFile('---\nid: G-1\nversion: 1\ntype: knowledge\nstatus: accepted\ntitle: t\nsummary: s\nscope:\n  level: global\n---\nbody')
    expect(global.frontmatter.scope).toEqual({ level: 'global' })
    const domain = parseKnowledgeFile('---\nid: D-1\nversion: 1\ntype: knowledge\nstatus: accepted\ntitle: t\nsummary: s\nscope:\n  level: domain\n  domainId: memory\n---\nbody')
    expect(domain.frontmatter.scope).toEqual({ level: 'domain', domainId: 'memory' })
  })

  it('throws with a descriptive error on contract violations', () => {
    expect(() => parseKnowledgeFile('no frontmatter here')).toThrow(/frontmatter block/)
    expect(() =>
      parseKnowledgeFile('---\nid: X-1\nversion: 1\ntype: nonsense\nstatus: accepted\ntitle: t\nsummary: s\nscope:\n  level: global\n---\n'),
    ).toThrow(/invalid `type`/)
    expect(() =>
      parseKnowledgeFile('---\nversion: 1\ntype: knowledge\nstatus: accepted\ntitle: t\nsummary: s\nscope:\n  level: global\n---\n'),
    ).toThrow(/missing `id`/)
  })

  it('handles quoted scalars, booleans, and empty tag arrays', () => {
    const file = parseKnowledgeFile(
      '---\nid: "Q-1"\nversion: 1\ntype: knowledge\nstatus: accepted\ntitle: 引号标题\nsummary: s\ntags: []\nscope:\n  level: global\n---\n',
    )
    expect(file.frontmatter.id).toBe('Q-1')
    expect(file.frontmatter.title).toBe('引号标题')
    expect(file.frontmatter.tags).toEqual([])
  })
})
