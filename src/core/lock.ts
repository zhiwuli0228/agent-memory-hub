import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWrite } from './atomic.js'
import { ErrorCode, HubError } from './errors.js'
import { LOCK_FILE } from './hub.js'

/**
 * Writer lock with lease + fencing token (predecessor ADR-0009, reimplemented):
 * a stuck writer is recovered by heartbeat age, not by manual lock deletion.
 * Old writers holding an older token degrade to read-only when they see a
 * newer token. All writers of one hub share this single process-agnostic file.
 */

export interface WriterLock {
  pid: number
  host: string
  acquiredAt: string
  heartbeatAt: string
  /** Monotonic fencing token: `lk-<base36 ms>-<rand>`; later acquirer wins. */
  token: string
}

export interface LockOptions {
  heartbeatMs?: number
  staleMs?: number
  now?: () => number
  host?: string
}

const DEFAULT_HEARTBEAT_MS = 15_000
const DEFAULT_STALE_MS = 45_000

function lockPath(root: string): string {
  return join(root, LOCK_FILE)
}

export function readLock(root: string): WriterLock | null {
  const path = lockPath(root)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as WriterLock
  } catch {
    // Corrupt lock file: treat as absent (recovery path, predecessor lesson).
    return null
  }
}

function lockAgeMs(lock: WriterLock, now: number): number {
  const parsed = Date.parse(lock.heartbeatAt)
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : now - parsed
}

/** True when the lock exists and its heartbeat is younger than staleMs. */
export function isLockFresh(root: string, options?: LockOptions): boolean {
  const lock = readLock(root)
  if (lock === null) return false
  const now = (options?.now ?? Date.now)()
  return lockAgeMs(lock, now) < (options?.staleMs ?? DEFAULT_STALE_MS)
}

export interface AcquireResult {
  ok: boolean
  lock?: WriterLock
  /** When !ok, the fresh lock held by someone else (readonly consumers surface this). */
  holder?: WriterLock
}

/**
 * Acquire the writer lease. Succeeds when no lock exists, or the existing
 * lock's heartbeat is older than staleMs (stuck writer auto-recovery).
 */
export function acquireLock(root: string, options?: LockOptions): AcquireResult {
  const now = (options?.now ?? Date.now)()
  const existing = readLock(root)
  if (existing !== null && lockAgeMs(existing, now) < (options?.staleMs ?? DEFAULT_STALE_MS)) {
    return { ok: false, holder: existing }
  }
  const lock: WriterLock = {
    pid: process.pid,
    host: options?.host ?? process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'unknown-host',
    acquiredAt: new Date(now).toISOString(),
    heartbeatAt: new Date(now).toISOString(),
    token: `lk-${now.toString(36)}-${randomUUID().slice(0, 8)}`,
  }
  atomicWrite(lockPath(root), `${JSON.stringify(lock, null, 2)}\n`)
  return { ok: true, lock }
}

/** Refresh the heartbeat; only succeeds while our own token is current. */
export function heartbeatLock(root: string, token: string, options?: LockOptions): boolean {
  const existing = readLock(root)
  if (existing === null || existing.token !== token) return false
  const now = (options?.now ?? Date.now)()
  existing.heartbeatAt = new Date(now).toISOString()
  atomicWrite(lockPath(root), `${JSON.stringify(existing, null, 2)}\n`)
  return true
}

/** Release only when we still hold the current token (never delete a successor's lock). */
export function releaseLock(root: string, token: string): boolean {
  const existing = readLock(root)
  if (existing === null || existing.token !== token) return false
  rmSync(lockPath(root), { force: true })
  return true
}

/**
 * Fencing check for a write performed under `token`: throws E_READONLY when a
 * newer writer has taken over (stale token). Call before every store mutation.
 */
export function assertFencing(root: string, token: string, options?: LockOptions): void {
  const existing = readLock(root)
  if (existing === null) return
  if (existing.token !== token) {
    throw new HubError(ErrorCode.E_READONLY, 'writer lease superseded by a newer writer (fencing token mismatch)', {
      currentToken: existing.token,
      holder: existing.host,
    })
  }
  const now = (options?.now ?? Date.now)()
  if (lockAgeMs(existing, now) >= (options?.staleMs ?? DEFAULT_STALE_MS)) {
    throw new HubError(ErrorCode.E_READONLY, 'writer lease expired (heartbeat overdue)', {
      heartbeatAt: existing.heartbeatAt,
    })
  }
}

/** File-level diagnostics (status tooling). */
export function lockInfo(
  root: string,
  options?: LockOptions,
): { held: boolean; fresh: boolean; lock?: WriterLock; sizeBytes?: number } {
  const lock = readLock(root)
  if (lock === null) return { held: false, fresh: false }
  const path = lockPath(root)
  const sizeBytes = existsSync(path) ? statSync(path).size : undefined
  return { held: true, fresh: isLockFresh(root, options), lock, sizeBytes }
}
