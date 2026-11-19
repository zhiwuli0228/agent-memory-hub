import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite } from './atomic.js'

/** Hub directory layout (storage contract). */
export const HUB_DIRS = ['knowledge', 'pending', 'history', 'records', 'journal'] as const
export const KNOWLEDGE_TYPES_DIR = [
  'decision',
  'constraint',
  'knowledge',
  'api-catalog',
  'process',
  'open-questions',
  'runtime-base',
  'playbooks',
  'assets',
] as const
export const HUB_CONFIG = 'hub.yaml'
export const HUB_README = 'MEMORY-HUB.md'
export const LEDGER_FILE = 'records/ledger.jsonl'
export const SEQUENCES_FILE = 'records/sequences.json'
export const LOCK_FILE = '.writer.lock'

export function isHubInitialized(root: string): boolean {
  return existsSync(join(root, 'knowledge')) && existsSync(join(root, LEDGER_FILE))
}

export function knowledgeDir(root: string, type: string): string {
  return join(root, 'knowledge', type)
}

export function historyDir(root: string, type: string): string {
  return join(root, 'history', type)
}

export function pendingDir(root: string): string {
  return join(root, 'pending')
}

export function journalDir(root: string): string {
  return join(root, 'journal')
}

/**
 * Initialize a hub directory. Idempotent: existing files are never touched
 * (fail-open for re-runs). Generates MEMORY-HUB.md explaining every folder's
 * writer/mutability/deletion semantics — except when a user README already
 * exists at that name (predecessor rule PRC-000009: never overwrite).
 */
export function initHub(root: string): { created: string[]; readme: 'written' | 'skipped-existing' } {
  const created: string[] = []
  for (const dir of HUB_DIRS) {
    const target = join(root, dir)
    if (!existsSync(target)) {
      mkdirSync(target, { recursive: true })
      created.push(dir)
    }
  }
  for (const type of KNOWLEDGE_TYPES_DIR) {
    const target = knowledgeDir(root, type)
    if (!existsSync(target)) mkdirSync(target, { recursive: true })
  }
  const records = join(root, 'records')
  if (!existsSync(join(records, 'sequences.json'))) {
    atomicWrite(join(records, 'sequences.json'), '{}\n')
  }
  if (!existsSync(join(records, 'ledger.jsonl'))) {
    writeFileSync(join(records, 'ledger.jsonl'), '', 'utf8')
  }
  // Git-when-ready: a .gitignore written at init time so the day the hub is
  // pushed to a remote, derived indexes and machine-local secrets (serve
  // token, lock files) never land in the shared history. Idempotent: an
  // existing .gitignore is never overwritten (predecessor rule PRC-000009).
  if (!existsSync(join(root, '.gitignore'))) {
    atomicWrite(join(root, '.gitignore'), hubGitignoreContent())
  }
  let readme: 'written' | 'skipped-existing' = 'skipped-existing'
  const readmePath = join(root, HUB_README)
  if (!existsSync(readmePath)) {
    atomicWrite(readmePath, hubReadmeContent())
    readme = 'written'
  }
  if (!existsSync(join(root, HUB_CONFIG))) {
    atomicWrite(join(root, HUB_CONFIG), defaultHubConfig())
  }
  return { created, readme }
}

/** Load and parse hub.yaml (flat `key: value` / one-level sections). */
export function readHubConfig(root: string): Record<string, string> {
  const path = join(root, HUB_CONFIG)
  if (!existsSync(path)) return {}
  const raw = readFileSync(path, 'utf8')
  const out: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const colon = trimmed.indexOf(':')
    if (colon === -1) continue
    out[trimmed.slice(0, colon).trim()] = trimmed.slice(colon + 1).trim()
  }
  return out
}

function defaultHubConfig(): string {
  return [
    '# agent-memory-hub configuration (plain text, diff-friendly).',
    '# workspaces auto-register on first use (ADR-0002); domains are optional.',
    'version: 1',
    '# domains: []   # optional grouping: domainId -> member workspace ids',
    '# --- publish (ADR-0015): where approved entries go. APIs are yours to define.',
    '# publish.adapter: http      # POST {entries:[...]} to publish.endpoint',
    '# publish.endpoint: https://memory-hub.example.internal/api/entries',
    '# publish.header.Authorization: Bearer <token>',
    '# publish.adapter: exec      # run your own script; stdin = entries JSON',
    '# publish.script: publish-to-memory-hub.mjs',
    '# publish.adapter: none      # (default) publishing disabled',
    '',
  ].join('\n')
}

function hubGitignoreContent(): string {
  return `# agent-memory-hub — git 仓库规划（init 时自动生成，可按需调整）
#
# 原则：权威数据全部提交；派生缓存与机器本地状态一律忽略。
# ADR-0023 三级联邦：knowledge/（共享）走 git；knowledge-private/（个人层，
# 按人不去重）永不进 git —— 团队/部门仓只承载共享知识。

# ── 个人私有记忆：按人划分，永不外流 ──
knowledge-private/

# ── per-hub 本地文件：联邦 git 只共享 knowledge/（各 hub 自持配置/说明）──
.gitignore
hub.yaml
README.md
MEMORY-HUB.md

# ── 派生缓存：运行时自动重建，提交只会制造合并冲突 ──
index/

# ── 机器本地状态：绝不能进共享历史 ──
# ADR-0023: records/ 整目录是 per-hub 本地状态（ID 序列、账本、锁、凭据）——
# 各 hub 独立记账，联邦同步只共享 knowledge/
records/

# ── 常规系统噪声 ──
.DS_Store
Thumbs.db
`
}

function hubReadmeContent(): string {
  return `# MEMORY-HUB — 目录说明书

本目录是 agent-memory-hub 的事实源。所有内容都是纯文本，可用 git 管理。

| 目录 | 内容 | 谁写 | 可改性 | 删除后果 |
| --- | --- | --- | --- | --- |
| knowledge/ | 已批准的知识（按类型分目录） | 只有"人批准"路径（commit） | 条目正文可由人直接编辑；元数据改动请走工具 | 该类知识消失；索引可重建，文件不可恢复 |
| pending/ | 模型创建的候选（PRO-*.md） | 模型（propose）与萃取器 | 人可编辑后批准；可整体删除 | 候选丢失，可重新生成 |
| history/ | 每次版本变更的原文快照 | commit/update 自动写 | **只追加**，请勿改写 | 版本追溯能力丢失 |
| records/ | ledger.jsonl（审批账本）+ sequences.json（ID 序列） | 工具自动 | **只追加**（ledger） | 审计链断裂，批准历史不可证 |
| journal/ | 情景层：自动捕获的会话流水 | 工具自动 | 可整体丢弃 | 无影响（可再生成），不影响 knowledge |
| .writer.lock | 写锁租约（心跳文件） | 写锁自动 | 勿手改 | 租约超龄自动回收 |

规则：模型永远不能自批；knowledge/ 的每一次写入都在 records/ledger.jsonl 有对应记录。
`
}
