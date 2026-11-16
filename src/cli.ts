import { existsSync, readFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ErrorCode, HubError } from './core/errors.js'
import { atomicWrite } from './core/atomic.js'
import { initHub, isHubInitialized, LEDGER_FILE, readHubConfig } from './core/hub.js'
import { appendLedger, ledgerPath, readLedger, readSequences, writeSequences } from './core/ledger.js'
import { acquireLock, assertFencing, lockInfo, releaseLock } from './core/lock.js'
import { registerWorkspace, resolveWorkspace } from './core/registry.js'
import { buildIndex, emptyMetrics, search } from './core/search.js'
import { commitKnowledge, getEntry, listEntries, listProposals } from './core/store.js'
import { validateHub } from './core/validate.js'
import { requireApproval } from './core/approval.js'
import { createApiState } from './transport/server.js'
import { autoCommit } from './transport/autocommit.js'
import { startServer, serverUrl } from './transport/http.js'
import { createState, handleRpc, serveStdio, TOOLS, type TransportState } from './transport/mcp.js'
import { buildExtractionMaterial, readExtractState, writeExtractState } from './core/extract.js'

/**
 * memhub CLI — same core, same behavior as the MCP tools (one behavior, one
 * implementation). Subcommands: init / mcp / search / get / status / propose /
 * inbox (list|approve|reject).
 */

interface CliArgs {
  _: string[]
  root: string
  workspace?: string
  json?: boolean
  limit?: number
  detail?: 'L0' | 'L1' | 'L2'
  full?: boolean
  channel?: string
  note?: string
  port?: number
  open?: boolean
  remote?: string
  message?: string
  since?: string
  branch?: string
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { _: [], root: process.env['MEMHUB_ROOT'] ?? process.cwd() }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === undefined) break
    switch (arg) {
      case '--root':
        args.root = argv[i + 1] ?? args.root
        i += 1
        break
      case '--workspace':
        args.workspace = argv[i + 1]
        i += 1
        break
      case '--json':
        args.json = true
        break
      case '--limit':
        args.limit = Number(argv[i + 1])
        i += 1
        break
      case '--detail':
        args.detail = argv[i + 1] as 'L0' | 'L1' | 'L2'
        i += 1
        break
      case '--full':
        args.full = true
        break
      case '--channel':
        args.channel = argv[i + 1]
        i += 1
        break
      case '--note':
        args.note = argv[i + 1]
        i += 1
        break
      case '--port':
        args.port = Number(argv[i + 1])
        i += 1
        break
      case '--no-open':
        args.open = false
        break
      case '--remote':
        args.remote = argv[i + 1]
        i += 1
        break
      case '--message':
        args.message = argv[i + 1]
        i += 1
        break
      case '--since':
        args.since = argv[i + 1]
        i += 1
        break
      case '--branch':
        args.branch = argv[i + 1]
        i += 1
        break
      default:
        args._.push(arg)
    }
  }
  return args
}

/** Open the URL in the OS default browser (best effort, never throws). */
function openInBrowser(url: string): void {
  const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const spawnArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    spawn(command, spawnArgs, { detached: true, stdio: 'ignore' }).unref()
  } catch {
    console.error(`(自动打开浏览器失败：请手动访问 ${url})`)
  }
}

function out(value: unknown, json?: boolean): void {  if (json) {
    console.log(JSON.stringify(value, null, 2))
  } else {
    console.log(JSON.stringify(value, null, 2))
  }
}

/** Print a failure to stderr; never exits (tests import main directly). */
function fail(error: unknown): void {
  if (error instanceof HubError) {
    console.error(`[${error.code}] ${error.message}`)
    if (error.details !== undefined) console.error(JSON.stringify(error.details))
  } else {
    console.error(error instanceof Error ? error.message : String(error))
  }
}

function requireHub(args: CliArgs): string {
  const root = resolve(args.root)
  if (!isHubInitialized(root)) {
    throw new HubError(ErrorCode.E_HUB_NOT_INITIALIZED, `hub not initialized at ${root} — run \`memhub init --root ${root}\``, { root })
  }
  return root
}

function humanLedger(root: string, record: Record<string, unknown>): void {
  appendLedger(ledgerPath(root), record as never)
}

/** Sentinel: the command keeps the process alive (stdio loop) — caller must not exit. */
export const KEEP_ALIVE = -1

export function main(argv: string[]): number {
  const args = parseArgs(argv)
  const command = args._[0]
  try {
    switch (command) {
      case 'init': {
        const root = resolve(args.root)
        const result = initHub(root)
        out({ root, ...result })
        return 0
      }
      case 'mcp': {
        const root = requireHub(args)
        const state = createState(root, args.workspace)
        serveStdio(state)
        return KEEP_ALIVE
      }
      case 'serve': {
        const root = requireHub(args)
        const state = createApiState(root, args.workspace)
        const port = args.port ?? 7777
        const server = startServer(state, { port })
        // Port 0 resolves asynchronously — print inside the listening event.
        server.on('listening', () => {
          const url = serverUrl(server)
          console.error(`memhub console: ${url}  (hub: ${root})`)
          console.error('保持此终端窗口开启 —— 关闭终端即停止控制台。按 Ctrl+C 退出。')
          if (args.open !== false) openInBrowser(url)
        })
        server.on('error', (error: NodeJS.ErrnoException) => {
          if (error.code === 'EADDRINUSE') {
            console.error(`[EADDRINUSE] 端口 ${port} 已被占用 —— 换一个端口：memhub serve --port 8080`)
          } else {
            console.error(`[serve error] ${error.message}`)
          }
          process.exit(1)
        })
        const shutdown = () => {
          server.close()
          process.exit(0)
        }
        process.on('SIGINT', shutdown)
        process.on('SIGTERM', shutdown)
        return KEEP_ALIVE
      }
      case 'search': {
        const root = requireHub(args)
        const query = args._.slice(1).join(' ')
        if (query === '') throw new HubError(ErrorCode.E_VALIDATION, 'usage: memhub search <query> [--detail L0|L1|L2] [--limit n]')
        const state = createState(root, args.workspace)
        const hits = search(state.index, query, {
          workspaceId: state.workspace.workspaceId,
          detail: args.detail ?? 'L1',
          limit: args.limit,
        })
        out({ hits, workspace: state.workspace.workspaceId }, args.json)
        return 0
      }
      case 'get': {
        const root = requireHub(args)
        const id = args._[1]
        if (id === undefined) throw new HubError(ErrorCode.E_VALIDATION, 'usage: memhub get <ID> [--full]')
        const entry = getEntry(root, id)
        out({ frontmatter: entry.frontmatter, body: args.full === true ? entry.body : undefined, path: entry.path }, args.json)
        return 0
      }
      case 'status': {
        const root = requireHub(args)
        const workspace = resolveWorkspace(process.cwd(), args.workspace)
        const index = buildIndex(root, () => new Date().toISOString())
        out(
          {
            hubRoot: root,
            workspace,
            lock: lockInfo(root),
            metrics: emptyMetrics(index),
            acceptedCount: listEntries(root).length,
            pendingCount: listProposals(root).length,
          },
          true,
        )
        return 0
      }
      case 'inbox': {
        const root = requireHub(args)
        const sub = args._[1] ?? 'list'
        if (sub === 'list') {
          out({ proposals: listProposals(root).map((p) => ({ id: p.id, title: p.frontmatter.title, type: p.frontmatter.type, path: p.path })) }, true)
          return 0
        }
        const proposalId = args._[2]
        if (proposalId === undefined) throw new HubError(ErrorCode.E_VALIDATION, `usage: memhub inbox ${sub} <PRO-id>`)
        if (sub === 'reject') {
          humanLedger(root, { type: 'proposal.rejected', proposalId, note: args.note, at: new Date().toISOString() })
          out({ rejected: proposalId })
          return 0
        }
        if (sub !== 'approve') throw new HubError(ErrorCode.E_VALIDATION, `unknown inbox subcommand: ${sub}`)
        // Human-carried channel: the person typed this command.
        requireApproval('cli-human', {
          id: proposalId,
          ledgerAppend: (record) => humanLedger(root, record),
        })
        const state = createState(root, args.workspace)
        const acquired = acquireLock(root)
        if (!acquired.ok) throw new HubError(ErrorCode.E_READONLY, 'another writer holds the lease', { holder: acquired.holder })
        try {
          assertFencing(root, acquired.lock?.token ?? '')
          const proposals = listProposals(root)
          const proposal = proposals.find((p) => p.id === proposalId)
          if (proposal === undefined) throw new HubError(ErrorCode.E_NOT_FOUND, `pending proposal not found: ${proposalId}`)
          const committed = commitKnowledge(
            root,
            {
              type: proposal.frontmatter.type,
              title: proposal.frontmatter.title,
              summary: proposal.frontmatter.summary,
              scope: proposal.frontmatter.scope,
              tags: proposal.frontmatter.tags,
              body: readFileSync(proposal.path, 'utf8').split('---')[2]?.trim() ?? '',
              actor: 'cli-human',
            },
            { readSequences, writeSequences, appendLedger: humanLedger },
          )
          humanLedger(root, { type: 'proposal.committed', proposalId, knowledgeId: committed.id, channel: 'cli-human', at: new Date().toISOString() })
          const gitCommit = autoCommit(root, `approve: ${committed.id}@v${committed.version} ${proposal.frontmatter.title}`)
          out({ knowledgeId: committed.id, version: committed.version, path: committed.path, git: gitCommit }, true)
          return 0
        } finally {
          releaseLock(root, acquired.lock?.token ?? '')
        }
      }
      case 'tools': {
        out(Object.keys(TOOLS), true)
        return 0
      }
      case 'validate': {
        const root = requireHub(args)
        const report = validateHub(root)
        out(report, args.json)
        return report.ok ? 0 : 1
      }
      case 'hub': {
        const root = requireHub(args)
        const sub = args._[1]
        const central = args.remote
        if (sub === undefined || central === undefined) {
          throw new HubError(ErrorCode.E_VALIDATION, 'usage: memhub hub <push|pull> --remote <central-serve-url> [--since <iso>]')
        }
        // main() is synchronous; hubSync is async — stash the promise so the
        // entry guard can await it (main never blocks an in-process server).
        pendingHubSync = (async () => {
          const result = await hubSync(root, sub, central.replace(/\/$/, ''), args.since)
          out(result, args.json)
          return result.ok ? 0 : 1
        })()
        return KEEP_ALIVE
      }
      case 'extract': {
        const root = requireHub(args)
        const sub = args._[1]
        if (sub === 'material') {
          const material = buildExtractionMaterial(root, args.since)
          out(material, true) // always JSON — it is consumed by an agent, not a human
          return 0
        }
        if (sub === 'done') {
          const at = args.since ?? new Date().toISOString()
          writeExtractState(root, at)
          const state = readExtractState(root)
          out({ ok: true, watermark: state.lastExtractedAt, extractionCount: state.extractionCount }, args.json)
          return 0
        }
        throw new HubError(ErrorCode.E_VALIDATION, 'usage: memhub extract <material|done> [--since <iso>]\n  material: what changed since the last watermark (feed to your workflow agent)\n  done:     advance the watermark after a successful extraction run')      }
      case 'sync': {
        const root = requireHub(args)
        const sub = args._[1]
        if (sub === undefined) throw new HubError(ErrorCode.E_VALIDATION, 'usage: memhub sync <status|init|push|pull> [--remote url] [--message text]')
        const result = syncCommand(root, sub, args.remote, args.message, args.branch)
        out(result, args.json)
        return result.ok ? 0 : 1
      }
      case 'publish': {
        // ADR-0015: the outbound API is the team's own to define — either a
        // configurable HTTP endpoint or their own script (which may call the
        // Tencent memory-hub API however it evolves). memhub never hardcodes it.
        const root = requireHub(args)
        const ids = args._.slice(1)
        pendingHubSync = (async () => {
          const result = await publishCommand(root, ids)
          out(result, args.json)
          return result.ok ? 0 : 1
        })()
        return KEEP_ALIVE
      }
      case 'help':
      case undefined:
        printHelp()
        return 0
      default:
        console.error(`unknown command: ${command}`)
        printHelp()
        return 1
    }
  } catch (error) {
    fail(error)
    return 1
  }
}

function git(root: string, argv: string[]): { ok: boolean; output: string } {
  const result = spawnSync('git', argv, { cwd: root, encoding: 'utf8' })
  if (result.error !== undefined) {
    return { ok: false, output: `git not available: ${(result.error as Error).message}` }
  }
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  return { ok: result.status === 0, output }
}

// ---------------------------------------------------------------------------
// ADR-0012 hub-to-hub sync: one resident `memhub serve` is the authority.
// push  = local approved entries become PROPOSALS on the central hub
//         (central inbox = the review gate; approve = merge, reject = no)
// pull  = central-approved entries apply locally by version comparison
// HTTP is async in-process: spawnSync would block this event loop, which
// deadlocks any hubSync invoked from a process that also hosts a server.
// ---------------------------------------------------------------------------

interface PushState { lastPushedAt: string }
interface PullState { lastPulledAt: string }

function readJsonState<T extends object>(root: string, file: string, fallback: T): T {
  const path = join(root, 'records', file)
  if (!existsSync(path)) return fallback
  try {
    return { ...fallback, ...(JSON.parse(readFileSync(path, 'utf8')) as object) } as T
  } catch {
    return fallback
  }
}

function writeJsonState(root: string, file: string, value: object): void {
  atomicWrite(join(root, 'records', file), JSON.stringify(value, null, 2) + '\n')
}

const PUSH_STATE_FILE = 'hub-push-state.json'
const PULL_STATE_FILE = 'hub-pull-state.json'

interface HubFetchResult { ok: boolean; status: number; body: Record<string, unknown> }

/** Injectable for tests; production hits the central hub over HTTP. */
export type HubFetch = (url: string, init?: { method?: string; body?: string }) => Promise<HubFetchResult>

const hubFetchHttp: HubFetch = async (url, init) => {
  const r = await fetch(url, {
    method: init?.method,
    headers: { 'content-type': 'application/json' },
    body: init?.body,
    signal: AbortSignal.timeout(20000),
  })
  return { ok: r.ok, status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> }
}

/** Exported for tests: hub-to-hub sync roundtrip (ADR-0012). */
export async function hubSync(
  root: string,
  sub: string,
  central: string,
  since?: string,
  fetchImpl: HubFetch = hubFetchHttp,
): Promise<{ ok: boolean; [key: string]: unknown }> {
  if (sub === 'push') {
    const state = readJsonState<PushState>(root, PUSH_STATE_FILE, { lastPushedAt: '' })
    const effectiveSince = since ?? state.lastPushedAt
    const all = listEntries(root, { includeSoftRemoved: false })
    const entries = effectiveSince === '' ? all : all.filter((e) => (e.frontmatter.updated ?? '') > effectiveSince)
    if (entries.length === 0) return { ok: true, pushed: 0, note: 'nothing new since last push' }
    const results: Array<{ localId: string; ok: boolean; proposalId?: string; error?: string }> = []
    for (const e of entries) {
      try {
        const r = await fetchImpl(`${central}/api/propose`, {
          method: 'POST',
          body: JSON.stringify({
            type: e.frontmatter.type,
            title: e.frontmatter.title,
            summary: e.frontmatter.summary,
            tags: e.frontmatter.tags,
            body: readFileSync(e.path, 'utf8').split('---')[2]?.trim() ?? '',
            sourceRefs: [`hub:${e.frontmatter.id}@v${e.frontmatter.version}`],
            originId: e.frontmatter.id,
            origin: `hub-push:${root.replace(/\\/g, '/').split('/').pop() ?? 'local'}`,
          }),
        })
        const body = r.body as { proposalId?: string; error?: string }
        results.push({ localId: e.frontmatter.id, ok: r.ok, ...(body.proposalId !== undefined ? { proposalId: body.proposalId } : {}), ...(body.error !== undefined ? { error: body.error } : {}) })
      } catch (error) {
        results.push({ localId: e.frontmatter.id, ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
    const pushed = results.filter((r) => r.ok).length
    if (pushed === entries.length) writeJsonState(root, PUSH_STATE_FILE, { lastPushedAt: new Date().toISOString() })
    return { ok: pushed > 0, pushed, total: entries.length, results, nextStep: 'central inbox review: approve = merge into the central knowledge base' }
  }
  if (sub === 'pull') {
    const state = readJsonState<PullState>(root, PULL_STATE_FILE, { lastPulledAt: '' })
    const effectiveSince = since ?? state.lastPulledAt
    const q = effectiveSince === '' ? '' : `?since=${encodeURIComponent(effectiveSince)}`
    // Remote-down resilience: transport exceptions degrade to an error
    // result (never escape — the hubSync caller must not crash on a dead
    // central hub).
    let listResult: { ok: boolean; status: number; body: Record<string, unknown> }
    try {
      listResult = await fetchImpl(`${central}/api/entries${q}`, { method: 'GET' })
    } catch (error) {
      return { ok: false, error: `central hub unreachable: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (!listResult.ok) return { ok: false, error: `central hub list failed: ${JSON.stringify(listResult.body).slice(0, 200)}` }
    const listed = (listResult.body as { entries?: Array<{ id: string; status: string }> }).entries ?? []
    const applied: string[] = []
    const skipped: string[] = []
    const errors: string[] = []
    for (const listedEntry of listed) {
      if (listedEntry.status !== 'accepted') continue
      try {
        let detail: { ok: boolean; status: number; body: Record<string, unknown> }
        try {
          detail = await fetchImpl(`${central}/api/entries/${encodeURIComponent(listedEntry.id)}`, { method: 'GET' })
        } catch (error) {
          errors.push(`${listedEntry.id}: detail fetch failed (${error instanceof Error ? error.message : String(error)})`)
          continue
        }
        if (!detail.ok) {
          errors.push(`${listedEntry.id}: detail fetch failed (${detail.status})`)
          continue
        }
        const d = detail.body as { frontmatter: { id: string; version: number; type: string; title: string; summary: string; scope: KnowledgeScopeLike; tags: string[]; updated: string }; body: string }
        let localVersion = 0
        try {
          localVersion = getEntry(root, d.frontmatter.id).frontmatter.version
        } catch {
          localVersion = 0 // not present locally
        }
        if (d.frontmatter.version <= localVersion) {
          skipped.push(d.frontmatter.id)
          continue
        }
        commitKnowledge(
          root,
          {
            ...(localVersion > 0 ? { id: d.frontmatter.id } : {}),
            type: d.frontmatter.type as Parameters<typeof commitKnowledge>[1]['type'],
            title: d.frontmatter.title,
            summary: d.frontmatter.summary,
            scope: d.frontmatter.scope as Parameters<typeof commitKnowledge>[1]['scope'],
            tags: d.frontmatter.tags,
            body: d.body,
            sourceRefs: [`central-hub:${d.frontmatter.id}@v${d.frontmatter.version}`],
            actor: 'remote-hub',
          },
          { readSequences, writeSequences, appendLedger: (r, record) => appendLedger(ledgerPath(r), record) },
        )
        applied.push(`${d.frontmatter.id}@v${d.frontmatter.version}`)
      } catch (error) {
        errors.push(`${listedEntry.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    writeJsonState(root, PULL_STATE_FILE, { lastPulledAt: new Date().toISOString() })
    autoCommit(root, `pull: applied ${applied.length} central entries`)
    return { ok: errors.length === 0, applied, skipped, errors, from: effectiveSince || '(beginning)' }
  }
  return { ok: false, error: `unknown hub subcommand: ${sub} (push|pull)` }
}

interface KnowledgeScopeLike { level: string; workspaceId?: string; domainId?: string }

// ---------------------------------------------------------------------------
// publish (ADR-0015): the outbound API is the TEAM'S OWN to define.
// adapter http  → POST {entries:[...]} to publish.endpoint (+ custom headers)
// adapter exec  → run publish.script with the entries JSON on stdin
// adapter none  → publishing disabled (default; config guidance returned)
// ---------------------------------------------------------------------------

interface PublishConfig {
  adapter: string
  endpoint?: string
  headers: Record<string, string>
  env: Record<string, string>
  script?: string
}

function readPublishConfig(root: string): PublishConfig {
  const config = readHubConfig(root)
  const headers: Record<string, string> = {}
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(config)) {
    const header = /^publish\.header\.(.+)$/.exec(key)
    if (header !== null && header[1] !== undefined) headers[header[1]] = value
    const envVar = /^publish\.env\.(.+)$/.exec(key)
    if (envVar !== null && envVar[1] !== undefined) env[envVar[1]] = value
  }
  return {
    adapter: config['publish.adapter'] ?? 'none',
    endpoint: config['publish.endpoint'],
    headers,
    env,
    script: config['publish.script'],
  }
}

const PUBLISH_STATE_FILE = 'publish-state.json'

interface PublishEntryPayload {
  id: string
  version: number
  type: string
  title: string
  summary: string
  scope: KnowledgeScopeLike
  tags: string[]
  updated: string
  sourceRefs: string
  body: string
}

function buildPublishPayload(root: string, ids: string[]): PublishEntryPayload[] {
  const all = listEntries(root, { includeSoftRemoved: false })
  const selected = ids.length > 0 ? all.filter((e) => ids.includes(e.frontmatter.id)) : all
  return selected.map((e) => ({
    id: e.frontmatter.id,
    version: e.frontmatter.version,
    type: e.frontmatter.type,
    title: e.frontmatter.title,
    summary: e.frontmatter.summary,
    scope: e.frontmatter.scope,
    tags: e.frontmatter.tags,
    updated: e.frontmatter.updated ?? '',
    sourceRefs: String(e.frontmatter.extra['source_refs'] ?? ''),
    body: readFileSync(e.path, 'utf8').split('---')[2]?.trim() ?? '',
  }))
}

export interface PublishTransport {
  (url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<{ ok: boolean; status: number; body: string }>
}

const publishHttpTransport: PublishTransport = async (url, init) => {
  const r = await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: AbortSignal.timeout(30000) })
  return { ok: r.ok, status: r.status, body: (await r.text().catch(() => '')).slice(0, 400) }
}

/** Exported for tests: ADR-0015 publish with a definable outbound API. */
export async function publishCommand(
  root: string,
  ids: string[],
  transport: PublishTransport = publishHttpTransport,
): Promise<{ ok: boolean; [key: string]: unknown }> {
  const config = readPublishConfig(root)
  if (config.adapter === 'none') {
    return {
      ok: false,
      error: 'no publish outlet configured',
      hint: '在 hub.yaml 里定义你的出口（API 由你们自定义，ADR-0015）：\n  publish.adapter: http + publish.endpoint: <你们的记忆库 API>\n  publish.adapter: exec + publish.script: <你的脚本，stdin 收条目 JSON>\n  publish.adapter: none  # 不发布',
    }
  }
  const entries = buildPublishPayload(root, ids)
  if (entries.length === 0) {
    if (ids.length > 0) return { ok: false, error: `no accepted entry matching: ${ids.join(', ')}` }
    return { ok: true, published: 0, note: 'nothing to publish' }
  }
  const body = JSON.stringify({ entries, publishedAt: new Date().toISOString() }, null, 2)
  let detail = ''
  let delivered = false
  if (config.adapter === 'http') {
    if (config.endpoint === undefined || config.endpoint === '') {
      return { ok: false, error: 'publish.adapter is http but publish.endpoint is not set' }
    }
    // A dead/misbehaving outlet must degrade to an error result — NEVER let
    // the transport exception escape (that is exactly the crash class the
    // direct-to-remote integration suffered: a 404 taking the host down).
    let r: { ok: boolean; status: number; body: string }
    try {
      r = await transport(config.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...config.headers }, body })
    } catch (error) {
      return { ok: false, error: `publish transport failed (remote down?): ${error instanceof Error ? error.message : String(error)}`, adapter: config.adapter }
    }
    delivered = r.ok
    detail = `HTTP ${r.status} ${r.body}`
  } else if (config.adapter === 'exec') {
    if (config.script === undefined || config.script === '') {
      return { ok: false, error: 'publish.adapter is exec but publish.script is not set' }
    }
    const scriptPath = join(root, config.script)
    if (!existsSync(scriptPath)) return { ok: false, error: `publish script not found: ${scriptPath}` }
    // Async spawn — NOT spawnSync: a blocked event loop cannot answer any
    // in-process server, and the script's fetches would deadlock (same
    // lesson as hubSync). Inherit the parent environment, then layer
    // publish.env.<NAME> on top (a token can come from the system env so
    // it never lands in hub.yaml).
    const run = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [scriptPath], { cwd: root, env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'] })
      child.stdin.write(body)
      child.stdin.end()
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
      child.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
      const timer = setTimeout(() => child.kill('SIGKILL'), 120000)
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ status: code, stdout, stderr })
      })
    })
    delivered = run.status === 0
    detail = run.stdout.trim().slice(0, 400)
    if (!delivered) detail = `${detail}\n${run.stderr.trim().slice(0, 400)}`.trim()
  } else {
    return { ok: false, error: `unknown publish.adapter: ${config.adapter} (http|exec|none)` }
  }
  if (!delivered) return { ok: false, error: `publish failed: ${detail}`, adapter: config.adapter }
  const ts = new Date().toISOString()
  if (ids.length === 0) writeJsonState(root, PUBLISH_STATE_FILE, { lastPublishedAt: ts })
  appendLedger(ledgerPath(root), { ts, actor: 'cli-human', action: 'publish', id: entries.map((e) => e.id).join(','), version: 0, source_refs: [] })
  return {
    ok: true,
    adapter: config.adapter,
    published: entries.length,
    ids: entries.map((e) => e.id),
    detail,
    nextStep: '已发布到你们定义的记忆库出口；水位线已记录，下次增量发布从 lastPublishedAt 开始',
  }
}

/** ADR-0011: the hub root IS a git repository — sync delegates to git. */
/** Exported for tests: git-backed center sync (ADR-0013). */
export function syncCommand(root: string, sub: string, remote?: string, message?: string, branch?: string): { ok: boolean; [key: string]: unknown } {
  const inside = git(root, ['rev-parse', '--is-inside-work-tree'])
  if (sub === 'init') {
    if (!inside.ok) {
      const init = git(root, ['init'])
      if (!init.ok) return { ok: false, error: init.output }
    }
    if (remote !== undefined) {
      const existing = git(root, ['remote', 'get-url', 'origin'])
      if (existing.ok) git(root, ['remote', 'set-url', 'origin', remote])
      else git(root, ['remote', 'add', 'origin', remote])
    }
    // Keep pending/ out of the repository: proposals are a local queue.
    const gitignore = join(root, '.gitignore')
    if (!existsSync(gitignore)) atomicWrite(gitignore, 'pending/\n')
    return { ok: true, action: 'init', nextStep: 'memhub sync push --message "initial memory snapshot"' }
  }
  if (!inside.ok) return { ok: false, error: `hub root is not a git repository — run: memhub sync init --remote <url>` }
  if (sub === 'status') {
    const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const dirty = git(root, ['status', '--porcelain'])
    const remoteUrl = git(root, ['remote', 'get-url', 'origin'])
    return {
      ok: true,
      branch: branch.output || '(none)',
      dirtyFiles: dirty.output === '' ? 0 : dirty.output.split('\n').length,
      remote: remoteUrl.ok ? remoteUrl.output : '(none configured)',
      hint: remoteUrl.ok ? 'memhub sync push / memhub sync pull' : 'memhub sync init --remote <url>',
    }
  }
  if (sub === 'push') {
    // ADR-0013: the center is the team's existing git service. Personal
    // branch mode (--branch) enables MR review without GitHub specifics:
    // push the branch, then open the MR on the git service's own UI.
    if (branch !== undefined) {
      const hasBranch = git(root, ['rev-parse', '--verify', branch])
      const switchTo = hasBranch.ok ? git(root, ['checkout', branch]) : git(root, ['checkout', '-b', branch])
      if (!switchTo.ok) return { ok: false, error: switchTo.output }
    }
    const add = git(root, ['add', '-A'])
    if (!add.ok) return { ok: false, error: add.output }
    const commit = git(root, ['commit', '-m', message ?? 'memhub sync: memory update'])
    const push = branch !== undefined ? git(root, ['push', '-u', 'origin', branch]) : git(root, ['push', '-u', 'origin', 'HEAD'])
    return {
      ok: push.ok,
      committed: commit.ok ? 'yes' : 'nothing to commit',
      pushed: push.ok ? 'yes' : 'no',
      branch: branch ?? '(current)',
      output: push.output || commit.output,
      ...(push.ok && branch !== undefined
        ? { nextStep: `在你的 git 服务上从分支 ${branch} 发起 MR —— 审查意见见 MR，改完再 push 即可；合入后其他人 memhub sync pull 同步` }
        : push.ok
          ? { nextStep: '已推送。团队协作建议：memhub sync push --branch <你的名字>，用 git 服务自带的 MR 审查合入' }
          : {}),
      ...(push.ok ? {} : { hint: 'if the remote uses PR review, open a PR from your branch' }),
    }
  }
  if (sub === 'pull') {
    const pull = git(root, ['pull', '--rebase'])
    return { ok: pull.ok, output: pull.output }
  }
  return { ok: false, error: `unknown sync subcommand: ${sub}` }
}

function printHelp(): void {
  console.log(`memhub — agent-memory-hub CLI

  memhub init --root <dir>            initialize a hub directory
  memhub mcp --root <dir>             start the MCP stdio server
  memhub serve --root <dir> [--port n] [--no-open]
                                      start the web console (auto-opens your browser;
                                      inbox + knowledge browser + audit; Ctrl+C stops)
  memhub search <query>               search accepted knowledge
      [--detail L0|L1|L2] [--limit n] [--workspace id] [--json]
  memhub get <ID> [--full]            read one entry
  memhub status                       hub/workspace/lock/metrics snapshot
  memhub inbox list                   list pending proposals
  memhub inbox approve <PRO-id>       human approval -> knowledge (ledgered)
  memhub inbox reject <PRO-id>        reject with optional --note
  memhub validate                     extraction validation over knowledge/ + pending/
                                      (exit 1 on errors — usable as CI gate)
  memhub extract material [--since]   extraction material since the watermark (JSON for
                                      ANY scheduler's agent: cron / workflow platform / CI)
  memhub extract done [--since iso]   advance the extraction watermark after a run
  memhub hub <push|pull> --remote <central-serve-url> [--since iso]
                                      ADR-0012 hub-to-hub sync: push local approved entries
                                      as central proposals (central inbox = review gate);
                                      pull central-approved entries into local knowledge
  memhub sync <status|init|push|pull> [--remote url] [--message text] [--branch name]
                                      THE center: publish knowledge to the team's existing
                                      git service (no dedicated server, ADR-0013); --branch
                                      pushes a personal branch for MR review on the git UI;
                                      serve stays local-only (inbox/browser/audit)
  memhub publish [IDs...]             publish approved entries to YOUR definable outlet
                                      (hub.yaml: publish.adapter http|exec — the API
                                      contract is yours, e.g. the Tencent memory hub)
  memhub tools                        list MCP tool names
  memhub help                         this text
`)
}

/** Entry guard: run the loop only when invoked directly as the bin target. */
const invokedDirectly =
  process.argv[1] !== undefined &&
  (import.meta.url === pathToFileURL(process.argv[1]).href ||
    process.argv[1].replace(/\\/g, '/').endsWith('/dist/cli.js'))

/** Set when a command (hub) defers its work to an async continuation. */
let pendingHubSync: Promise<number> | null = null

if (invokedDirectly && process.argv.length > 2) {
  const code = main(process.argv.slice(2))
  // TS narrows pendingHubSync to null here (assignment happens inside main);
  // cast through unknown so the async continuation still runs.
  const job = pendingHubSync as unknown as Promise<number> | null
  if (code === KEEP_ALIVE && job !== null) {
    job.then((exitCode) => process.exit(exitCode)).catch(() => process.exit(1))
  } else if (code !== KEEP_ALIVE) {
    process.exit(code)
  }
}

export { createState, handleRpc, type TransportState, readHubConfig, readLedger, registerWorkspace, LEDGER_FILE }
