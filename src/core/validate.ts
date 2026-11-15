import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseKnowledgeFrontmatter } from './frontmatter.js'

/**
 * Extraction validation (ADR-0011): contract checks over knowledge/ and
 * pending/ so a proposal is proven mergeable before it is committed and
 * pushed. Pure file checks — no git, no host dependencies.
 */

export interface ValidationIssue {
  file: string
  message: string
}

export interface ValidationReport {
  ok: boolean
  checked: { knowledge: number; pending: number }
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
}

function mdFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  const walk = (d: string): void => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, f.name)
      if (f.isDirectory()) walk(p)
      else if (f.name.endsWith('.md')) out.push(p)
    }
  }
  walk(dir)
  return out
}

export function validateHub(root: string): ValidationReport {
  const errors: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []
  const ids = new Map<string, string>()
  const titles = new Map<string, string>()

  // Normalize separators: on Windows, backslashes would break the path
  // filters below. history/ holds version snapshots (not live entries —
  // they legitimately repeat ids); pending/archive/ holds processed
  // proposals from predecessor hubs (not the live approval queue).
  const allMd = mdFiles(root).map((p) => p.replace(/\\/g, '/'))
  const knowledgeFiles = allMd.filter((p) => p.includes('/knowledge/') && !p.includes('/history/'))
  for (const path of knowledgeFiles) {
    const rel = path.slice(root.replace(/\\/g, '/').length + 1)
    let fm: ReturnType<typeof parseKnowledgeFrontmatter>
    try {
      fm = parseKnowledgeFrontmatter(readFileSync(path, 'utf8'))
    } catch (error) {
      errors.push({ file: rel, message: error instanceof Error ? error.message : String(error) })
      continue
    }
    const idOwner = ids.get(fm.id)
    if (idOwner !== undefined && idOwner !== rel) {
      errors.push({ file: rel, message: `duplicate id ${fm.id} (also in ${idOwner})` })
    } else {
      ids.set(fm.id, rel)
    }
    const titleOwner = titles.get(fm.title)
    if (titleOwner !== undefined && titleOwner !== fm.id) {
      warnings.push({ file: rel, message: `title conflicts with ${titleOwner}: "${fm.title}"` })
    } else {
      titles.set(fm.title, fm.id)
    }
    if (fm.status === 'superseded' && typeof fm.extra['supersedes'] !== 'string') {
      warnings.push({ file: rel, message: 'status superseded but no supersedes reference recorded' })
    }
  }

  const pendingFiles = allMd.filter((p) => p.includes('/pending/') && !p.includes('/pending/archive/'))
  for (const path of pendingFiles) {
    const rel = path.slice(root.replace(/\\/g, '/').length + 1)
    let fm: ReturnType<typeof parseKnowledgeFrontmatter>
    try {
      fm = parseKnowledgeFrontmatter(readFileSync(path, 'utf8'), { context: 'proposal' })
    } catch (error) {
      errors.push({ file: rel, message: error instanceof Error ? error.message : String(error) })
      continue
    }
    if (ids.has(fm.id)) errors.push({ file: rel, message: `proposal id ${fm.id} collides with an accepted entry` })
    const titleOwner = titles.get(fm.title)
    if (titleOwner !== undefined) {
      // createProposal already refuses this at write time; a stale pending file may still trip it.
      warnings.push({ file: rel, message: `title identical to accepted ${titleOwner} — commit will conflict` })
    }
    const raw = fm.extra['supersedes']
    // Legacy empty-array literals (`supersedes: []`) are "no target", not an id.
    if (typeof raw === 'string' && raw !== '' && raw !== '[]') {
      for (const target of raw.split(/\s+/)) {
        if (target !== '' && !ids.has(target)) {
          errors.push({ file: rel, message: `supersedes target ${target} not found in knowledge/` })
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    checked: { knowledge: knowledgeFiles.length, pending: pendingFiles.length },
    errors,
    warnings,
  }
}
