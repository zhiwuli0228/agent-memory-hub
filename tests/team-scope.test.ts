import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { commitKnowledge, getEntry } from '../src/core/store.js'
import { appendLedger, readSequences, writeSequences } from '../src/core/ledger.js'
import { initHub } from '../src/core/hub.js'
import { buildIndex, isVisibleIn, search } from '../src/core/search.js'
import { createApiState, type ApiState } from '../src/transport/server.js'
import { startServer } from '../src/transport/http.js'
import { hubSync, type HubFetch } from '../src/cli.js'
import type { Server } from 'node:http'

function helpers(root: string) {
  return { readSequences, writeSequences, appendLedger: (r: string, rec: Record<string, unknown>) => appendLedger(join(r, 'records', 'ledger.jsonl'), rec as never) }
}

describe('ADR-0019 team scope', () => {
  const root = mkdtempSync(join(tmpdir(), 'amh-team-'))
  const h = helpers(root)
  initHub(root)
  const globalEntry = getEntry(root, commitKnowledge(root, { type: 'decision', title: '全公司发布规范', summary: '所有团队遵循统一的发布流程规范', scope: { level: 'global' }, tags: [], body: 'company wide', actor: 't' }, h).id)
  const teamEntry = getEntry(root, commitKnowledge(root, { type: 'process', title: '前端团队组件规范', summary: '前端组件命名与目录结构约定', scope: { level: 'domain', domainId: 'team-frontend' }, tags: [], body: 'frontend team rules', actor: 't' }, h).id)
  const otherTeam = getEntry(root, commitKnowledge(root, { type: 'process', title: '后端团队部署规范', summary: '后端服务的部署与回滚流程', scope: { level: 'domain', domainId: 'team-backend' }, tags: [], body: 'backend rules', actor: 't' }, h).id)
  const projectEntry = getEntry(root, commitKnowledge(root, { type: 'knowledge', title: '本项目本地调试技巧', summary: '这个仓库独有的调试环境变量', scope: { level: 'project', workspaceId: 'proj-x' }, tags: [], body: 'project only', actor: 't' }, h).id)
  const index = buildIndex(root, () => new Date().toISOString())

  it('union visibility: global ∪ declared team ∪ declared project', () => {
    const viewer = { workspaceId: 'proj-x', teamId: 'team-frontend' }
    expect(isVisibleIn(globalEntry.frontmatter.scope, viewer)).toBe(true)
    expect(isVisibleIn(teamEntry.frontmatter.scope, viewer)).toBe(true)
    expect(isVisibleIn(otherTeam.frontmatter.scope, viewer)).toBe(false)
    expect(isVisibleIn(projectEntry.frontmatter.scope, viewer)).toBe(true)
  })

  it('team-only viewer sees team + global, not other teams nor projects', () => {
    const viewer = { teamId: 'team-frontend' }
    expect(isVisibleIn(teamEntry.frontmatter.scope, viewer)).toBe(true)
    expect(isVisibleIn(otherTeam.frontmatter.scope, viewer)).toBe(false)
    expect(isVisibleIn(projectEntry.frontmatter.scope, viewer)).toBe(false)
  })

  it('search respects the declared team', () => {
    const hits = search(index, '规范', { teamId: 'team-frontend' })
    const ids = hits.map((x) => x.id)
    expect(ids).toContain(teamEntry.frontmatter.id)
    expect(ids).toContain(globalEntry.frontmatter.id)
    expect(ids).not.toContain(otherTeam.frontmatter.id)
  })

  it('no declared scope searches the whole hub (central read side)', () => {
    const hits = search(index, '规范')
    expect(hits.map((x) => x.id)).toEqual(expect.arrayContaining([teamEntry.frontmatter.id, otherTeam.frontmatter.id, globalEntry.frontmatter.id]))
  })

  it('hub push carries the team scope through to the central proposal', async () => {
    const received: Array<Record<string, unknown>> = []
    const fetchImpl: HubFetch = async (_url, init) => {
      received.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>)
      return { ok: true, status: 200, body: { proposalId: 'PRO-TEST' } }
    }
    await hubSync(root, 'push', 'http://central.test', undefined, fetchImpl)
    const teamPush = received.find((p) => p['title'] === '前端团队组件规范')
    expect(teamPush).toBeDefined()
    expect(teamPush?.['scope']).toEqual({ level: 'domain', domainId: 'team-frontend' })
  })
})

describe('ADR-0019 central /api/search team parameter', () => {
  const root = mkdtempSync(join(tmpdir(), 'amh-team-api-'))
  let server: Server
  let state: ApiState
  afterAll(() => {
    server?.close()
    server?.closeAllConnections()
  })

  it('GET /api/search?team=... filters to the declared team + global', async () => {
    initHub(root)
    const h = helpers(root)
    commitKnowledge(root, { type: 'process', title: '前端团队组件规范', summary: '前端组件命名约定', scope: { level: 'domain', domainId: 'team-frontend' }, tags: [], body: 'rules', actor: 't' }, h)
    commitKnowledge(root, { type: 'process', title: '后端团队部署规范', summary: '后端部署流程', scope: { level: 'domain', domainId: 'team-backend' }, tags: [], body: 'rules', actor: 't' }, h)
    state = createApiState(root)
    server = startServer(state, { port: 0 })
    await new Promise<void>((resolve) => server.on('listening', () => resolve()))
    const port = (server.address() as { port: number }).port
    const r = await fetch(`http://127.0.0.1:${port}/api/search?q=${encodeURIComponent('规范')}&team=team-frontend`)
    expect(r.status).toBe(200)
    const body = (await r.json()) as { hits: Array<{ entryId: string; title?: string }>; workspace: string }
    const titles = body.hits.map((x) => x.title ?? '')
    expect(titles.join('|')).toContain('前端')
    expect(titles.join('|')).not.toContain('后端')
    expect(body.workspace).toBe('team:team-frontend')
  })
})
