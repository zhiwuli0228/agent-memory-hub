import { execFileSync } from 'node:child_process'
import { basename, isAbsolute, resolve } from 'node:path'
import type { KnowledgeScope } from './types.js'

/**
 * Workspace identity resolution (ADR-0002, zero-config):
 *   1. explicit --workspace argument (human-specified, highest priority)
 *   2. git origin remote URL (stable across subdirs & worktrees)
 *   3. canonical project directory (git root, else cwd)
 *   4. synthetic workspace with exact=false (honest fallback)
 * First use auto-registers (persisted by the caller on the write path);
 * resolution itself is pure/read-only.
 */

export interface ResolvedWorkspace {
  /** Stable workspace id (slug of origin owner/repo or directory name). */
  workspaceId: string
  /** Human-editable display name. */
  name: string
  /** Canonical absolute path this identity was derived from. */
  path: string
  /** Git origin URL when available. */
  origin?: string
  /** false when the identity is a synthetic fallback (honest labeling). */
  exact: boolean
}

/** Run a git command; return stdout or null on any failure (git missing, not a repo). */
export function git(args: string[], cwd: string): string | null {
  try {
    const out = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })
    return out.trim() === '' ? null : out.trim()
  } catch {
    return null
  }
}

/** Slugify an origin URL ("git@github.com:owner/repo.git" -> "owner-repo"). */
export function workspaceIdFromOrigin(origin: string): string {
  const cleaned = origin
    .replace(/^git@[^:]+:/, '')
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/\.git$/, '')
    .toLowerCase()
  const slug = cleaned.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return slug === '' ? 'workspace' : slug
}

export function slugifyDir(path: string): string {
  // Split on BOTH separators explicitly: path.basename is platform-aware
  // (Windows-only '\' on win32, '/' on POSIX) and hubs legitimately carry
  // cross-platform path strings.
  const lastSegment = path.split(/[\\/]/).filter(Boolean).pop() ?? ''
  const slug = lastSegment
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug === '' ? 'workspace' : slug
}

/** Find the git root upward from dir; null when not inside a repository. */
export function gitRoot(dir: string): string | null {
  const top = git(['rev-parse', '--show-toplevel'], dir)
  return top !== null && isAbsolute(top) ? resolve(top) : null
}

/** Resolve workspace identity for a working directory (pure — never writes). */
export function resolveWorkspace(dir: string, explicitId?: string): ResolvedWorkspace {
  const abs = resolve(dir)
  if (explicitId !== undefined && explicitId !== '') {
    return { workspaceId: explicitId, name: explicitId, path: abs, exact: true }
  }
  const origin = git(['remote', 'get-url', 'origin'], abs)
  if (origin !== null) {
    return { workspaceId: workspaceIdFromOrigin(origin), name: basename(abs), path: abs, origin, exact: true }
  }
  const root = gitRoot(abs)
  const canonical = root ?? abs
  return { workspaceId: slugifyDir(canonical), name: basename(canonical), path: canonical, exact: true }
}

/** Scope for read/write from a resolved workspace. */
export function scopeForWorkspace(workspaceId: string): KnowledgeScope {
  return { level: 'project', workspaceId }
}

/** Registered workspace record (persisted in hub.yaml workspaces table). */
export interface RegisteredWorkspace {
  workspaceId: string
  name: string
  origin?: string
  registeredAt: string
}

/** Load the workspaces table from hub.yaml's flat `workspaces.<id>.name` rows. */
export function readRegisteredWorkspaces(config: Record<string, string>): RegisteredWorkspace[] {
  const out: RegisteredWorkspace[] = []
  for (const [key, value] of Object.entries(config)) {
    const match = /^workspaces\.([.\w-]+)\.name$/.exec(key)
    if (match?.[1] === undefined) continue
    const id = match[1]
    out.push({
      workspaceId: id,
      name: value,
      origin: config[`workspaces.${id}.origin`],
      registeredAt: config[`workspaces.${id}.registeredAt`] ?? '',
    })
  }
  return out
}

/** Persist (upsert) a workspace row into hub.yaml. Caller must hold the write lock. */
export function registerWorkspace(
  hubRoot: string,
  ws: ResolvedWorkspace,
  nowIso: () => string,
  readConfig: (root: string) => Record<string, string>,
  writeConfig: (root: string, content: string) => void,
): void {
  const config = readConfig(hubRoot)
  const nameKey = `workspaces.${ws.workspaceId}.name`
  if (config[nameKey] !== undefined) {
    // Already registered — keep as-is (name edits go through the panel/CLI).
    return
  }
  // Append the new row(s) instead of rewriting the whole file (keeps comments).
  const lines: string[] = [`workspaces.${ws.workspaceId}.name: ${ws.name}`]
  if (ws.origin !== undefined) lines.push(`workspaces.${ws.workspaceId}.origin: ${ws.origin}`)
  lines.push(`workspaces.${ws.workspaceId}.registeredAt: ${nowIso()}`)
  writeConfig(hubRoot, `${lines.join('\n')}\n`)
}
