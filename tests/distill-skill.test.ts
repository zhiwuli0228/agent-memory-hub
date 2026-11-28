import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SKILL_DIR = join(process.cwd(), 'skills', 'memory-distill')

function read(rel: string): string {
  return readFileSync(join(SKILL_DIR, rel), 'utf8')
}

/**
 * The extraction skill is part of the product surface (ADR-0031): without it a
 * scheduler has nothing to drive, and without the mandated wiring fields every
 * distill proposal silently lands in the instant inbox instead of the second
 * review queue.
 */
describe('memory-distill skill', () => {
  it('ships the SKILL.md entry point with frontmatter name + description', () => {
    expect(existsSync(join(SKILL_DIR, 'SKILL.md'))).toBe(true)
    const md = read('SKILL.md')
    expect(md.startsWith('---')).toBe(true)
    expect(md).toContain('name: memory-distill')
    expect(md).toContain('description:')
    // Progressive disclosure: "when to use" AND "when not to use".
    expect(md).toContain('何时使用')
    expect(md).toContain('何时不要使用')
  })

  it('documents the run lifecycle the hub expects', () => {
    const md = read('SKILL.md')
    expect(md).toContain('distill due')
    expect(md).toContain('distill run start')
    expect(md).toContain('extract material')
    expect(md).toContain('distill run finish')
    expect(md).toContain('distill run fail')
    // The wiring fields are the make-or-break detail.
    expect(md).toContain('origin: "distill"')
    expect(md).toContain('originId')
  })

  it('prompts encode the research findings (negative list, evidence, atomicity)', () => {
    const l1 = read(join('prompt', 'extract-l1.md'))
    // The negative list matters more than the positive one.
    expect(l1).toContain('不抽什么')
    expect(l1).toContain('可从代码/文档直接推导的')
    expect(l1).toContain('无证据的推测')
    // Atomicity + self-containment.
    expect(l1).toContain('一条一结论')
    expect(l1).toContain('句句自含')
    // Evidence must be a verbatim quote.
    expect(l1).toContain('原文片段')
    // Relative-time anchoring rule.
    expect(l1).toContain('observation_date')

    const l2 = read(join('prompt', 'merge-l2.md'))
    expect(l2).toContain('≥2 条证据')
    expect(l2).toContain('绝不覆盖 L1')
  })

  it('self-check checklist gates value, evidence, quality, dedupe and wiring', () => {
    const check = read(join('checklists', 'self-check.md'))
    for (const section of ['A. 价值', 'B. 证据', 'C. 质量', 'D. 去重', 'E. 类型与审批等级', 'F. 接线']) {
      expect(check).toContain(section)
    }
    expect(check).toContain('丢弃')
  })

  it('proposal schema requires the batch wiring and at least one evidence ref', () => {
    const schema = JSON.parse(read(join('schema', 'proposal.schema.json'))) as {
      required: string[]
      properties: Record<string, { const?: string; pattern?: string; minItems?: number }>
    }
    expect(schema.required).toContain('sourceRefs')
    expect(schema.required).toContain('origin')
    expect(schema.required).toContain('originId')
    expect(schema.properties['origin']?.const).toBe('distill')
    expect(schema.properties['sourceRefs']?.minItems).toBe(1)
    // Self-reported confidence must be documented as informational only.
    const conf = read(join('schema', 'proposal.schema.json'))
    expect(conf).toContain('INFORMATIONAL ONLY')
  })
})
