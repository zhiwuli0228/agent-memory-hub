/**
 * Knowledge entry types — the hub-directory format contract.
 *
 * Format compatibility with dsh-memory-hub hub directories is a hard contract:
 * this repo reads existing hub directories directly (zero migration). The type
 * shape below mirrors the stable subset of that format; drift is prevented by
 * cross-referenced format contract tests in both repos.
 */

/** Knowledge type classification (stable across both repos). */
export type KnowledgeType =
  | 'decision'
  | 'constraint'
  | 'knowledge'
  | 'api-catalog'
  | 'process'
  | 'open-questions'
  | 'runtime-base'
  | 'playbooks'
  | 'assets'

/** Lifecycle status of an entry. */
export type KnowledgeStatus =
  | 'candidate'
  | 'accepted'
  | 'rejected'
  | 'superseded'
  | 'deprecated'

/** Scope levels: project < domain < global. A project entry belongs to exactly one workspace. */
export type KnowledgeScope =
  | { level: 'global' }
  | { level: 'domain'; domainId: string }
  | { level: 'project'; workspaceId: string }

/**
 * Parsed frontmatter of a knowledge file. Unknown keys are preserved verbatim
 * (forward compatibility): readers must not drop fields they do not understand.
 */
export interface KnowledgeFrontmatter {
  id: string
  version: number
  type: KnowledgeType
  status: KnowledgeStatus
  title: string
  summary: string
  scope: KnowledgeScope
  tags: string[]
  created?: string
  updated?: string
  last_verified?: string
  /** Unknown/extra frontmatter keys, preserved as-is. */
  extra: Record<string, unknown>
}

/** A knowledge file split into its contract parts. */
export interface ParsedKnowledgeFile {
  frontmatter: KnowledgeFrontmatter
  /** Body Markdown, without the frontmatter block, trimmed. */
  body: string
}
