import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendLedger, ledgerPath, readSequences, writeSequences } from '../src/core/ledger.js'
import { commitKnowledge } from '../src/core/store.js'
import { initHub } from '../src/core/hub.js'
import { createApiState, handleApi, gradeFor, type ApiState } from '../src/transport/server.js'
import { hubSync, type HubFetch } from '../src/cli.js'
import type { LedgerRecord } from '../src/core/ledger.js'

function helpers(nowIsoValue?: string) {
  return {
    nowIsoValue,
    readSequences,
    writeSequences,
    appendLedger: (root: string, record: LedgerRecord) => appendLedger(ledgerPath(root), record),
  }
}

function tempHub(): string {
  const root = mkdtempSync(join(tmpdir(), 'amh-central-'))
  initHub(root)
  return root
}

/** In-memory central hub behind the HubFetch seam — no sockets, no deadlock. */
function centralFetch(centralState: ApiState): HubFetch {
  return async (url, init) => {
    const u = new URL(url)
    const body = init?.body !== undefined ? (JSON.parse(init.body) as Record<string, unknown>) : Object.fromEntries(u.searchParams)
    const resp = handleApi(centralState, init?.method ?? 'GET', u.pathname, body)
    return { ok: resp.status < 400, status: resp.status, body: resp.body as Record<string, unknown> }
  }
}

describe('ADR-0012 hub-to-hub sync', () => {
  it('remote propose lands in the central inbox as a proposal', () => {
    const centralRoot = tempHub()
    const state = createApiState(centralRoot, undefined)
    const response = handleApi(state, 'POST', '/api/propose', {
      type: 'process',
      title: '通用环境登录部署流程',
      summary: '任意目标环境的登录与部署',
      body: '环境差异通过变量注入',
      origin: 'hub-push:desktop',
      sourceRefs: ['hub:PRC-000001@v1'],
    })
    expect(response.status).toBe(200)
    const inbox = handleApi(state, 'GET', '/api/inbox')
    const proposals = (inbox.body as { proposals: Array<{ title: string; grade: string }> }).proposals
    expect(proposals).toHaveLength(1)
    expect(proposals[0]?.title).toBe('通用环境登录部署流程')
    expect(proposals[0]?.grade).toBe(gradeFor('process'))
  })

  it('entries?since returns only entries updated after the timestamp', () => {
    const root = tempHub()
    const state = createApiState(root, undefined)
    commitKnowledge(root, { type: 'knowledge', title: '旧', summary: 's', scope: { level: 'global' }, tags: [], body: 'x', sourceRefs: ['n'] }, helpers('2026-11-01T00:00:00.000Z'))
    commitKnowledge(root, { type: 'knowledge', title: '新', summary: 's', scope: { level: 'global' }, tags: [], body: 'y', sourceRefs: ['n'] }, helpers('2026-11-10T00:00:00.000Z'))
    const full = handleApi(state, 'GET', '/api/entries', {})
    expect((full.body as { count: number }).count).toBe(2)
    const incremental = handleApi(state, 'GET', '/api/entries', { since: '2026-11-05T00:00:00.000Z' })
    const entries = (incremental.body as { entries: Array<{ title: string }>; count: number }).entries
    expect((incremental.body as { count: number }).count).toBe(1)
    expect(entries[0]?.title).toBe('新')
  })

  it('push → central approve → pull roundtrip keeps entry identity stable', async () => {
    const localRoot = tempHub()
    const centralRoot = tempHub()
    commitKnowledge(localRoot, { type: 'process', title: '本地已批准的通用流程', summary: '通用环境登录部署', scope: { level: 'project', workspaceId: 'desktop' }, tags: ['universal'], body: '流程正文', sourceRefs: ['note:x'] }, helpers())
    const centralState = createApiState(centralRoot, undefined)
    const fetchImpl = centralFetch(centralState)

    const push = await hubSync(localRoot, 'push', 'http://central.test', undefined, fetchImpl)
    expect(push.ok).toBe(true)
    expect(push.pushed).toBe(1)

    const inbox = (handleApi(centralState, 'GET', '/api/inbox').body as { proposals: Array<{ id: string }> }).proposals
    expect(inbox).toHaveLength(1)
    const approve = handleApi(centralState, 'POST', `/api/inbox/${inbox[0]?.id}/approve`)
    expect(approve.status).toBe(200)
    // The central entry carries the SOURCE hub's id (not a new central id).
    const centralEntries = (handleApi(centralState, 'GET', '/api/entries', {}).body as { entries: Array<{ id: string; version: number }> }).entries
    expect(centralEntries).toHaveLength(1)
    expect(centralEntries[0]?.version).toBe(1)

    // pull back to the SAME hub: identical version → skipped (idempotent)
    const pull = await hubSync(localRoot, 'pull', 'http://central.test', undefined, fetchImpl)
    expect(pull.ok).toBe(true)
    expect(pull.applied).toHaveLength(0)
    expect(pull.skipped).toHaveLength(1)

    // pull to a FRESH hub (another machine): the entry arrives with its identity
    const otherRoot = tempHub()
    const pull2 = await hubSync(otherRoot, 'pull', 'http://central.test', undefined, fetchImpl)
    expect(pull2.ok).toBe(true)
    expect(pull2.applied).toHaveLength(1)
    const otherEntries = (handleApi(createApiState(otherRoot, undefined), 'GET', '/api/entries', {}).body as { entries: Array<{ id: string; version: number; title: string }> }).entries
    expect(otherEntries).toHaveLength(1)
    expect(otherEntries[0]?.title).toBe('本地已批准的通用流程')
    expect(otherEntries[0]?.id).toMatch(/^PRC-/)
  })

  it('pull degrades gracefully when the central hub is unreachable (no crash)', async () => {
    const localRoot = tempHub()
    const fetchImpl: HubFetch = async () => {
      throw new Error('fetch failed: ECONNREFUSED')
    }
    const r = await hubSync(localRoot, 'pull', 'http://central.test', undefined, fetchImpl)
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('central hub unreachable')
  })

  it('sync push --branch creates a personal branch for MR review (ADR-0013)', async () => {
    const { syncCommand } = await import('../src/cli.js')
    const { spawnSync } = await import('node:child_process')
    const root = tempHub()
    commitKnowledge(root, { type: 'process', title: '团队通用流程', summary: 's', scope: { level: 'global' }, tags: [], body: 'b', sourceRefs: ['n'] }, helpers())

    // A local bare repo stands in for the team's git service (real push, no network).
    const bare = mkdtempSync(join(tmpdir(), 'amh-bare-'))
    spawnSync('git', ['init', '--bare', bare], { encoding: 'utf8' })
    spawnSync('git', ['config', 'user.email', 't@t'], { cwd: root, encoding: 'utf8' })
    spawnSync('git', ['config', 'user.name', 't'], { cwd: root, encoding: 'utf8' })

    expect(syncCommand(root, 'init', bare).ok).toBe(true)
    const push = syncCommand(root, 'push', undefined, undefined, 'alice')
    expect(push.pushed).toBe('yes')
    expect(push.branch).toBe('alice')
    expect(String(push.nextStep)).toContain('MR')
    // The branch really exists on the "team git service" and locally.
    const remoteBranches = spawnSync('git', ['branch', '--list', 'alice'], { cwd: bare, encoding: 'utf8' })
    expect(remoteBranches.stdout).toContain('alice')
    const localBranch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' })
    expect(localBranch.stdout.trim()).toBe('alice')
  })

  it('a revised push bumps the central version (feedback loop: revise → push again)', async () => {
    const localRoot = tempHub()
    const centralRoot = tempHub()
    commitKnowledge(localRoot, { type: 'process', title: '流程', summary: 'v1 绑定环境', scope: { level: 'global' }, tags: [], body: 'v1', sourceRefs: ['n'] }, helpers())
    const centralState = createApiState(centralRoot, undefined)
    const fetchImpl = centralFetch(centralState)

    await hubSync(localRoot, 'push', 'http://central.test', undefined, fetchImpl)
    const inbox1 = (handleApi(centralState, 'GET', '/api/inbox').body as { proposals: Array<{ id: string }> }).proposals
    handleApi(centralState, 'POST', `/api/inbox/${inbox1[0]?.id}/approve`)

    // Reviewer asked for generalization → local edit → push again
    commitKnowledge(localRoot, { id: 'PRC-000001', type: 'process', title: '流程', summary: 'v2 已通用化', scope: { level: 'global' }, tags: [], body: 'v2 通用正文', sourceRefs: ['n'], actor: 'panel' }, helpers())
    await hubSync(localRoot, 'push', 'http://central.test', undefined, fetchImpl)
    const inbox2 = (handleApi(centralState, 'GET', '/api/inbox').body as { proposals: Array<{ id: string }> }).proposals
    expect(inbox2).toHaveLength(1)
    const approve2 = handleApi(centralState, 'POST', `/api/inbox/${inbox2[0]?.id}/approve`)
    expect(approve2.status).toBe(200)
    // Central entry is now v2 with the generalized content — merged, not duplicated.
    const centralEntries = (handleApi(centralState, 'GET', '/api/entries', {}).body as { entries: Array<{ id: string; version: number; summary: string }> }).entries
    expect(centralEntries).toHaveLength(1)
    expect(centralEntries[0]?.version).toBe(2)
    expect(centralEntries[0]?.summary).toContain('通用化')
  })
})
