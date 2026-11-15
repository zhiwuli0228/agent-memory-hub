import type {
  KnowledgeFrontmatter,
  KnowledgeScope,
  KnowledgeStatus,
  KnowledgeType,
} from './types.js'

/**
 * Minimal zero-dependency YAML frontmatter parser for the hub-directory
 * knowledge format. This is a contract implementation: it must parse exactly
 * what dsh-memory-hub writes (single-level scalars, inline arrays, and the
 * nested `scope` object), and preserve unknown keys verbatim.
 *
 * Deliberately NOT a general YAML parser — see invariant 3 (plain text) and
 * principle 6 (zero dependencies). The contract tests in tests/format.test.ts
 * lock the supported surface; extend the parser only together with those tests.
 */

const KNOWLEDGE_TYPES: readonly KnowledgeType[] = [
  'decision',
  'constraint',
  'knowledge',
  'api-catalog',
  'process',
  'open-questions',
  'runtime-base',
  'playbooks',
  'assets',
]

const KNOWLEDGE_STATUSES: readonly KnowledgeStatus[] = [
  'candidate',
  'accepted',
  'rejected',
  'superseded',
  'deprecated',
]

const FENCED_DELIMITER = '---'

/**
 * Extract the leading frontmatter block (between the first two `---` lines).
 * Returns null when the file does not start with a frontmatter block.
 */
export function splitFrontmatter(raw: string): { yaml: string; body: string } | null {
  if (!raw.startsWith(FENCED_DELIMITER)) return null
  const firstNewline = raw.indexOf('\n')
  if (firstNewline === -1) return null
  const opener = raw.slice(0, firstNewline).trim()
  if (opener !== FENCED_DELIMITER) return null
  const rest = raw.slice(firstNewline + 1)
  const closing = findClosingLine(rest)
  if (closing === -1) return null
  const yaml = rest.slice(0, closing)
  const body = rest.slice(closing + FENCED_DELIMITER.length).replace(/^\n/, '')
  return { yaml, body: body.trim() }
}

function findClosingLine(text: string): number {
  let offset = 0
  for (const line of text.split('\n')) {
    if (line.trim() === FENCED_DELIMITER) return offset
    offset += line.length + 1
  }
  return -1
}

/** Parse one scalar value: quoted/unquoted string, number, boolean. */
function parseScalar(value: string): string | number | boolean {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1)
  }
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  const num = Number(trimmed)
  if (trimmed !== '' && Number.isFinite(num) && /^-?\d+(\.\d+)?$/.test(trimmed)) return num
  return trimmed
}

/** Parse an inline array: `[a, b, c]` or an empty `[]`. */
function parseInlineArray(value: string): string[] {
  const inner = value.trim().slice(1, -1).trim()
  if (inner === '') return []
  return inner.split(',').map((item) => String(parseScalar(item)))
}

function parseScope(lines: string[], start: number): { scope: KnowledgeScope; next: number } {
  // Nested object under `scope:` — exactly two indented keys in the contract:
  // level plus domainId|workspaceId.
  const scopeLines: string[] = []
  let index = start
  while (index < lines.length) {
    const line = lines[index]
    if (line === undefined) break
    if (line.trim() === '' || /^\S/.test(line)) break
    scopeLines.push(line.trim())
    index += 1
  }
  const entries = new Map<string, string>()
  for (const line of scopeLines) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    entries.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim())
  }
  const level = entries.get('level')
  let scope: KnowledgeScope = { level: 'global' }
  if (level === 'domain' && entries.get('domainId')) {
    scope = { level: 'domain', domainId: entries.get('domainId') as string }
  } else if (level === 'project' && entries.get('workspaceId')) {
    scope = { level: 'project', workspaceId: entries.get('workspaceId') as string }
  }
  return { scope, next: index }
}

/**
 * Parse a knowledge file's frontmatter into the contract type.
 * Throws with a descriptive message on contract violations (id/type/status
 * missing or invalid) — the caller decides how to surface the error.
 *
 * `context: 'proposal'` relaxes the contract for pending-proposal files:
 * predecessor-era proposals carry `status: pending` and no version (assigned
 * at commit time), both of which are legacy aliases mapped here.
 */
export function parseKnowledgeFrontmatter(
  raw: string,
  options?: { context?: 'entry' | 'proposal' },
): KnowledgeFrontmatter {
  const split = splitFrontmatter(raw)
  if (split === null) {
    throw new Error('knowledge file must start with a `---` frontmatter block')
  }
  const lines = split.yaml.split('\n')
  const scalars = new Map<string, string | number | boolean>()
  const extra: Record<string, unknown> = {}
  let scope: KnowledgeScope = { level: 'global' }
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line === undefined || line.trim() === '' || line.trim().startsWith('#')) {
      index += 1
      continue
    }
    if (/^\S/.test(line)) {
      const colon = line.indexOf(':')
      if (colon === -1) {
        index += 1
        continue
      }
      const key = line.slice(0, colon).trim()
      const value = line.slice(colon + 1).trim()
      if (key === 'scope') {
        if (value === '') {
          const parsed = parseScope(lines, index + 1)
          scope = parsed.scope
          index = parsed.next
          continue
        }
        scope = parseInlineArrayOrScalarAsScope(value)
        index += 1
        continue
      }
      if (key === 'tags' || key === 'source_refs') {
        if (value === '') {
          // Legacy block-style list: `key:` followed by indented `- item` lines.
          const items: string[] = []
          let cursor = index + 1
          while (cursor < lines.length) {
            const item = lines[cursor]
            if (item === undefined || !/^\s+-\s/.test(item)) break
            items.push(item.replace(/^\s+-\s*/, '').trim())
            cursor += 1
          }
          if (items.length > 0) {
            if (key === 'tags') {
              // Re-encode into the inline `[a, b]` convention parseInlineArray expects.
              scalars.set('tags', `[${items.join(', ')}]`)
            } else {
              // Match the renderer's single-line convention (join with spaces).
              const joined = items.join(' ')
              scalars.set('source_refs', joined)
              extra['source_refs'] = joined
            }
            index = cursor
            continue
          }
        }
        const parsedValue = value === '[]' ? '[]' : parseScalar(value)
        scalars.set(key, parsedValue)
        if (key === 'source_refs') extra['source_refs'] = parsedValue
        index += 1
        continue
      }
      const parsed = parseScalar(value)
      scalars.set(key, parsed)
      extra[key] = parsed
      index += 1
      continue
    }
    index += 1
  }

  const id = scalars.get('id')
  if (typeof id !== 'string' || id === '') throw new Error('frontmatter missing `id`')
  const type = scalars.get('type')
  if (typeof type !== 'string' || !KNOWLEDGE_TYPES.includes(type as KnowledgeType)) {
    throw new Error(`frontmatter has invalid \`type\`: ${String(type)}`)
  }
  const rawStatus = scalars.get('status')
  // Legacy alias: predecessor-era pending proposals carry `status: pending` —
  // the same concept as the new `candidate` status.
  const status = rawStatus === 'pending' ? 'candidate' : rawStatus
  if (typeof status !== 'string' || !KNOWLEDGE_STATUSES.includes(status as KnowledgeStatus)) {
    throw new Error(`frontmatter has invalid \`status\`: ${String(status)}`)
  }
  const versionRaw = scalars.get('version')
  // Proposal context: predecessor-era pending files carry no version — the
  // version is assigned at commit time, so default to 1.
  const version =
    typeof versionRaw === 'number'
      ? versionRaw
      : options?.context === 'proposal'
        ? 1
        : (undefined as unknown as number)
  if (typeof version !== 'number') throw new Error('frontmatter missing numeric `version`')
  const title = scalars.get('title')
  if (typeof title !== 'string' || title === '') throw new Error('frontmatter missing `title`')
  const summary = scalars.get('summary')
  if (typeof summary !== 'string') throw new Error('frontmatter missing `summary`')
  const tagsRaw = scalars.get('tags')
  const tags = typeof tagsRaw === 'string' && tagsRaw !== '[]'
    ? parseInlineArray(tagsRaw)
    : typeof tagsRaw === 'string'
      ? []
      : []

  // Contract keys are hoisted into their typed fields; unknown keys stay in extra.
  for (const contractKey of [
    'id',
    'version',
    'type',
    'status',
    'title',
    'summary',
    'created',
    'updated',
    'last_verified',
  ]) {
    delete extra[contractKey]
  }

  return {
    id,
    version,
    type: type as KnowledgeType,
    status: status as KnowledgeStatus,
    title,
    summary,
    scope,
    tags,
    // Optional keys are omitted (never `undefined`) so parsed frontmatter is
    // lossless-JSON safe for host tool outputs, even on legacy entries that
    // predate these fields (old format kept timestamps in extra.*_at).
    ...(asOptionalString(scalars.get('created')) !== undefined
      ? { created: asOptionalString(scalars.get('created')) }
      : {}),
    ...(asOptionalString(scalars.get('updated')) !== undefined
      ? { updated: asOptionalString(scalars.get('updated')) }
      : {}),
    ...(asOptionalString(scalars.get('last_verified')) !== undefined
      ? { last_verified: asOptionalString(scalars.get('last_verified')) }
      : {}),
    extra,
  }
}

function asOptionalString(value: string | number | boolean | undefined): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function parseInlineArrayOrScalarAsScope(value: string): KnowledgeScope {
  // Legacy bare shorthand: `scope: project:<id>` / `scope: domain:<id>` / `scope: global`.
  const bare = /^(global|domain:([\w.-]+)|project:([\w.-]+))$/.exec(value)
  if (bare !== null) {
    if (bare[1] === 'global') return { level: 'global' }
    if (bare[2] !== undefined) return { level: 'domain', domainId: bare[2] }
    if (bare[3] !== undefined) return { level: 'project', workspaceId: bare[3] }
  }
  // Accept `{level: global}` style inline maps for the global case only.
  if (/level:\s*global/.test(value)) return { level: 'global' }
  if (/level:\s*domain/.test(value)) {
    const domainId = /domainId:\s*([\w.-]+)/.exec(value)?.[1]
    if (domainId) return { level: 'domain', domainId }
  }
  if (/level:\s*project/.test(value)) {
    const workspaceId = /workspaceId:\s*([\w.-]+)/.exec(value)?.[1]
    if (workspaceId) return { level: 'project', workspaceId }
  }
  return { level: 'global' }
}

/** Parse a full knowledge file (frontmatter + body). */
export function parseKnowledgeFile(raw: string): { frontmatter: KnowledgeFrontmatter; body: string } {
  const split = splitFrontmatter(raw)
  if (split === null) throw new Error('knowledge file must start with a `---` frontmatter block')
  return { frontmatter: parseKnowledgeFrontmatter(raw), body: split.body }
}
