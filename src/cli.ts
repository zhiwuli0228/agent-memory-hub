import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ErrorCode, HubError } from './core/errors.js'
import { initHub, isHubInitialized, LEDGER_FILE, readHubConfig } from './core/hub.js'
import { appendLedger, ledgerPath, readLedger, readSequences, writeSequences } from './core/ledger.js'
import { acquireLock, assertFencing, lockInfo, releaseLock } from './core/lock.js'
import { registerWorkspace, resolveWorkspace } from './core/registry.js'
import { buildIndex, emptyMetrics, search } from './core/search.js'
import { commitKnowledge, getEntry, listEntries, listProposals } from './core/store.js'
import { requireApproval } from './core/approval.js'
import { createApiState } from './transport/server.js'
import { startServer, serverUrl } from './transport/http.js'
import { createState, handleRpc, serveStdio, TOOLS, type TransportState } from './transport/mcp.js'

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
      default:
        args._.push(arg)
    }
  }
  return args
}

function out(value: unknown, json?: boolean): void {
  if (json) {
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
          console.error(`memhub console: ${serverUrl(server)}  (hub: ${root})`)
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
          out({ knowledgeId: committed.id, version: committed.version, path: committed.path }, true)
          return 0
        } finally {
          releaseLock(root, acquired.lock?.token ?? '')
        }
      }
      case 'tools': {
        out(Object.keys(TOOLS), true)
        return 0
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

function printHelp(): void {
  console.log(`memhub — agent-memory-hub CLI

  memhub init --root <dir>            initialize a hub directory
  memhub mcp --root <dir>             start the MCP stdio server
  memhub serve --root <dir> [--port n] start the web console (127.0.0.1, inbox + knowledge browser + audit)
  memhub search <query>               search accepted knowledge
      [--detail L0|L1|L2] [--limit n] [--workspace id] [--json]
  memhub get <ID> [--full]            read one entry
  memhub status                       hub/workspace/lock/metrics snapshot
  memhub inbox list                   list pending proposals
  memhub inbox approve <PRO-id>       human approval -> knowledge (ledgered)
  memhub inbox reject <PRO-id>        reject with optional --note
  memhub tools                        list MCP tool names
  memhub help                         this text
`)
}

/** Entry guard: run the loop only when invoked directly as the bin target. */
const invokedDirectly =
  process.argv[1] !== undefined &&
  (import.meta.url === pathToFileURL(process.argv[1]).href ||
    process.argv[1].replace(/\\/g, '/').endsWith('/dist/cli.js'))
if (invokedDirectly && process.argv.length > 2) {
  const code = main(process.argv.slice(2))
  if (code !== KEEP_ALIVE) process.exit(code)
}

export { createState, handleRpc, type TransportState, readHubConfig, readLedger, registerWorkspace, LEDGER_FILE }
