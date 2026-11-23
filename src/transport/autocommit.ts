import { spawnSync } from 'node:child_process'

/**
 * ADR-0011 push policy (user decision 2026-11-15): approved knowledge
 * changes are committed to the LOCAL git history immediately — fine-grained
 * history, offline-safe. `git push` stays an explicit / scheduled step so
 * central-repo commits remain batched and reviewable. Silently no-ops when
 * the hub root is not a git repository (never blocks approval).
 *
 * Every git spawn is bounded: an approval must never hang the console on a
 * slow/locked working tree (Windows AV scanning .git, NFS stalls, index
 * contention). A timeout degrades the commit to `{committed:false}` with a
 * detail line — the approval itself still returns.
 */
const GIT_TIMEOUT_MS = 10_000

function git(root: string, args: string[]): { status: number | null; output: string; timedOut: boolean } {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: GIT_TIMEOUT_MS })
  if (r.error !== undefined && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    return { status: null, output: 'git timed out', timedOut: true }
  }
  return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}`, timedOut: false }
}

export function autoCommit(root: string, message: string): { committed: boolean; detail?: string } {
  const inside = git(root, ['rev-parse', '--is-inside-work-tree'])
  if (inside.timedOut) return { committed: false, detail: 'git timed out (working tree busy)' }
  if (inside.status !== 0) return { committed: false, detail: 'not a git repository' }
  const add = git(root, ['add', '-A'])
  if (add.timedOut) return { committed: false, detail: 'git add timed out (working tree busy)' }
  if (add.status !== 0) return { committed: false, detail: `git add failed: ${(add.output ?? '').trim().slice(0, 200)}` }
  const commit = git(root, ['commit', '-m', message])
  if (commit.timedOut) return { committed: false, detail: 'git commit timed out (working tree busy)' }
  if (commit.status !== 0) {
    if (commit.output.includes('nothing to commit')) return { committed: false, detail: 'nothing to commit' }
    return { committed: false, detail: commit.output.trim().slice(0, 200) }
  }
  return { committed: true }
}
