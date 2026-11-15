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
        const result = syncCommand(root, sub, args.remote, args.message)
        out(result, args.json)
        return result.ok ? 0 : 1
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
    const listResult = await fetchImpl(`${central}/api/entries${q}`, { method: 'GET' })
    if (!listResult.ok) return { ok: false, error: `central hub list failed: ${JSON.stringify(listResult.body).slice(0, 200)}` }
    const listed = (listResult.body as { entries?: Array<{ id: string; status: string }> }).entries ?? []
    const applied: string[] = []
    const skipped: string[] = []
    const errors: string[] = []
    for (const listedEntry of listed) {
      if (listedEntry.status !== 'accepted') continue
      try {
        const detail = await fetchImpl(`${central}/api/entries/${encodeURIComponent(listedEntry.id)}`, { method: 'GET' })
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

/** ADR-0011: the hub root IS a git repository — sync delegates to git. */
function syncCommand(root: string, sub: string, remote?: string, message?: string): { ok: boolean; [key: string]: unknown } {
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
    const add = git(root, ['add', '-A'])
    if (!add.ok) return { ok: false, error: add.output }
    const commit = git(root, ['commit', '-m', message ?? 'memhub sync: memory update'])
    const push = git(root, ['push', '-u', 'origin', 'HEAD'])
    return {
      ok: push.ok,
      committed: commit.ok ? 'yes' : 'nothing to commit',
      pushed: push.ok ? 'yes' : 'no',
      output: push.output || commit.output,
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
  memhub sync <status|init|push|pull> [--remote url] [--message text]
                                      optional git backup of the hub directory (ADR-0011,
                                      demoted to disaster recovery by ADR-0012)
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
