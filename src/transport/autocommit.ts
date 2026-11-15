import { spawnSync } from 'node:child_process'

/**
 * ADR-0011 push policy (user decision 2026-11-15): approved knowledge
 * changes are committed to the LOCAL git history immediately — fine-grained
 * history, offline-safe. `git push` stays an explicit / scheduled step so
 * central-repo commits remain batched and reviewable. Silently no-ops when
 * the hub root is not a git repository (never blocks approval).
 */
export function autoCommit(root: string, message: string): { committed: boolean; detail?: string } {
  const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' })
  if (inside.error !== undefined || inside.status !== 0) return { committed: false, detail: 'not a git repository' }
  const add = spawnSync('git', ['add', '-A'], { cwd: root, encoding: 'utf8' })
  if (add.error !== undefined || add.status !== 0) return { committed: false, detail: `git add failed: ${(add.stderr ?? '').trim().slice(0, 200)}` }
  const commit = spawnSync('git', ['commit', '-m', message], { cwd: root, encoding: 'utf8' })
  const output = `${commit.stdout ?? ''}${commit.stderr ?? ''}`
  if (commit.status !== 0) {
    if (output.includes('nothing to commit')) return { committed: false, detail: 'nothing to commit' }
    return { committed: false, detail: output.trim().slice(0, 200) }
  }
  return { committed: true }
}
