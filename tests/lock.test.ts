import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  acquireLock,
  assertFencing,
  heartbeatLock,
  isLockFresh,
  lockInfo,
  readLock,
  releaseLock,
} from '../src/core/lock.js'

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'amh-lock-'))
}

function fakeNow(start: number): () => number {
  let current = start
  return () => {
    current += 1000
    return current
  }
}

describe('writer lock lease', () => {
  it('acquires when free, and reports the holder when fresh', () => {
    const root = tempRoot()
    const first = acquireLock(root, { now: fakeNow(1_000_000) })
    expect(first.ok).toBe(true)
    expect(first.lock?.token).toMatch(/^lk-/)
    const second = acquireLock(root, { now: fakeNow(1_000_000) })
    expect(second.ok).toBe(false)
    expect(second.holder?.pid).toBe(process.pid)
    expect(isLockFresh(root, { now: fakeNow(1_000_000) })).toBe(true)
  })

  it('auto-recovers a stuck writer once the heartbeat exceeds the stale window', () => {
    const root = tempRoot()
    const t1 = fakeNow(1_000_000)
    const stuck = acquireLock(root, { now: t1 })
    expect(stuck.ok).toBe(true)
    // 60s later with no heartbeat (>45s stale) — a new writer takes over.
    const recovery = acquireLock(root, { now: fakeNow(1_061_000) })
    expect(recovery.ok).toBe(true)
    expect(recovery.lock?.token).not.toBe(stuck.lock?.token)
  })

  it('heartbeat refreshes the lease only for the current token', () => {
    const root = tempRoot()
    const lock = acquireLock(root, { now: fakeNow(1_000_000) })
    expect(heartbeatLock(root, 'lk-bogus', { now: fakeNow(1_000_000) })).toBe(false)
    expect(heartbeatLock(root, lock.lock!.token, { now: fakeNow(1_001_000) })).toBe(true)
    expect(readLock(root)?.heartbeatAt).not.toBe(lock.lock?.heartbeatAt)
  })

  it('fencing rejects a superseded token and an expired lease', () => {
    const root = tempRoot()
    const old = acquireLock(root, { now: fakeNow(1_000_000) })
    // A newer writer takes over after staleness.
    const newer = acquireLock(root, { now: fakeNow(1_100_000) })
    expect(newer.ok).toBe(true)
    expect(() => assertFencing(root, old.lock!.token, { now: fakeNow(1_101_000) })).toThrowError(/fencing/)
    expect(() => assertFencing(root, newer.lock!.token, { now: fakeNow(1_101_000) })).not.toThrow()
  })

  it('release removes only our own lock; a successor stays in place', () => {
    const root = tempRoot()
    const first = acquireLock(root, { now: fakeNow(1_000_000) })
    releaseLock(root, first.lock!.token)
    expect(readLock(root)).toBeNull()
    const second = acquireLock(root, { now: fakeNow(2_000_000) })
    expect(releaseLock(root, first.lock!.token)).toBe(false)
    expect(readLock(root)?.token).toBe(second.lock?.token)
  })

  it('lockInfo reports held/fresh state for status surfaces', () => {
    const root = tempRoot()
    const t = fakeNow(1_000_000_000_000) // near real epoch so Date-based staleness works
    expect(lockInfo(root, { now: t }).held).toBe(false)
    acquireLock(root, { now: t })
    const info = lockInfo(root, { now: t })
    expect(info.held).toBe(true)
    expect(info.fresh).toBe(true)
    expect(info.lock?.host).not.toBe('')
  })
})
