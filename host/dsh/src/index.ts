import { execSync } from 'node:child_process'
import * as hub from 'agent-memory-hub'
import { resolveHubRoot, type AdapterConfig, type HostContext, type ToolDefinition } from './host-types.js'
import { createTools, createHubContext } from './tools.js'

/**
 * DSH thin adapter for agent-memory-hub (ADR-0001: no host glue in core —
 * the host side is this package). Registers memory_* tools on the cordis
 * tools service; initialization is async-safe: registration is synchronous,
 * tool bodies handle hub errors and return structured payloads, so a failed
 * mount never throws into the host loader.
 *
 * Also embeds the panel HTTP surface in-process (127.0.0.1:7777, ADR-0012)
 * so the DSH sidebar panel always has its audited data source — no manual
 * `memhub serve` step. Port conflicts (a user-started serve, another session)
 * are tolerated: we skip and the existing server keeps serving.
 */

export const name = 'agent-memory-hub-dsh'
export const inject = ['tools', 'systemPrompt']

function resolvePanelPort(config?: AdapterConfig): number {
  const raw = config?.panelPort ?? process.env['DSH_AMH_PANEL_PORT']
  if (raw === undefined || raw === null || raw === '') return 7777
  const port = Number(raw)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    // eslint-disable-next-line no-console
    console.warn(`agent-memory-hub-dsh: invalid panel port ${JSON.stringify(raw)}, using 7777`)
    return 7777
  }
  return port
}

function listenWithRetry(ctx: HostContext, state: ReturnType<typeof hub.createApiState>, port: number, attempts = 4): void {
  let server: ReturnType<typeof hub.startServer>
  try {
    server = hub.startServer(state, { port, host: '127.0.0.1' })
  } catch (error) {
    if (attempts > 1) {
      // The previous mount's server may still be draining keep-alive
      // connections; its teardown closes them, so retry shortly.
      setTimeout(() => listenWithRetry(ctx, state, port, attempts - 1), 1000)
      return
    }
    ctx.logger?.warn(`agent-memory-hub-dsh: panel server failed to start: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      ctx.logger?.info(`agent-memory-hub-dsh: panel port ${port} already serving — reusing it`)
      return
    }
    ctx.logger?.warn(`agent-memory-hub-dsh: panel server error: ${error.message}`)
  })
  ctx.logger?.info(`agent-memory-hub-dsh: panel console serving at http://127.0.0.1:${port}/`)
  ctx.effect?.(() => () => {
    try {
      // close() alone waits for keep-alive connections to drain, which can
      // block the port for seconds; cut them so a re-mount binds immediately.
      server.closeAllConnections()
      server.close()
    } catch {
      // already closed
    }
  }, `${name}-panel`)
}

function startPanelServer(ctx: HostContext, root: string, config?: AdapterConfig): void {
  try {
    const state = hub.createApiState(root)
    listenWithRetry(ctx, state, resolvePanelPort(config))
  } catch (error) {
    ctx.logger?.warn(`agent-memory-hub-dsh: panel server failed to start: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function apply(ctx: HostContext, config?: AdapterConfig): void {
  const root = resolveHubRoot(config)
  if (!hub.isHubInitialized(root)) {
    ctx.logger?.warn(
      `agent-memory-hub-dsh: hub not initialized at ${root} — memory tools disabled until \`memhub init --root ${root}\` runs`,
    )
    return
  }
  startPanelServer(ctx, root, config)
  const hubCtx = createHubContext(config)
  const conflict = config?.toolConflict ?? 'skip'
  const disposers: Array<() => void> = []
  for (const definition of createTools(hubCtx)) {
    const { run, ...rest } = definition
    let toolName = rest.name
    const existing = ctx.tools.get(toolName)
    if (existing !== undefined) {
      if (conflict === 'skip') {
        ctx.logger?.warn(
          `agent-memory-hub-dsh: tool ${toolName} already registered by host or another plugin; skipping (toolConflict: skip)`,
        )
        continue
      }
      toolName = `${toolName}__amh`
      ctx.logger?.warn(`agent-memory-hub-dsh: tool name collision — registered as ${toolName} (toolConflict: suffix)`)
    }
    const tool: ToolDefinition = {
      ...rest,
      name: toolName,
      execute: (args) => run(args),
    }
    disposers.push(ctx.tools.register(tool))
  }
  ctx.logger?.info(`agent-memory-hub-dsh: ${disposers.length} memory tools registered (hub: ${root})`)

  // ── Session lifecycle hooks (restores the predecessor's capability) ──
  // 老版本记忆管理（dsh-memory-evolve 时代）有两个主动钩子，v0.1.2x 的纯
  // 工具化重构把它们丢了，这里恢复：
  //  1) 会话开始前查询：systemPrompt 尾消息注入本轮记忆快照（L0 hits +
  //     行为引导），DSH 只在文本变化时重新附加，缓存友好；
  //  2) 结束后提交：同一注入内带结束引导——模型在收尾时调 memory_close_task
  //     / memory_propose 写回（老版本同款机制：引导语驱动，不做后台魔法写）。
  if (ctx.systemPrompt !== undefined) {
    let lastText = ''
    let lastAt = 0
    const disposersSystem = () => {
      try {
        const dispose = ctx.systemPrompt?.context({
          name: 'agent-memory-hub:snapshot',
          order: 90,
          text: (context) => {
            // Throttle: BM25 over a large hub is cheap but not free, and
            // this runs on every render; 30s TTL keeps it negligible.
            const now = Date.now()
            if (now - lastAt < 30_000 && lastText !== '') return lastText
            lastAt = now
            const cwd = context.agent?.session?.header?.cwd
            const intent = cwd !== undefined ? `项目上下文 ${cwd.split(/[\\/]/).pop() ?? cwd}` : '当前工作上下文'
            try {
              // Federation liveness line (restores "可见的远端变化感知"):
              // local entry count + ahead/behind vs the central remote.
              let liveness = ''
              try {
                const total = hub.listEntries(hubCtx.root).length
                const st = execSync(`git -C ${JSON.stringify(hubCtx.root)} status -sb`, { timeout: 3000 }).toString().split('\n')[0] ?? ''
                const ahead = /ahead (\d+)/.exec(st)?.[1]
                const behind = /behind (\d+)/.exec(st)?.[1]
                const state = ahead !== undefined || behind !== undefined
                  ? `领先 ${ahead ?? 0} / 落后 ${behind ?? 0}（memhub sync push/pull 同步）`
                  : '与中心一致'
                liveness = `本地 ${total} 条（含私有）· 与中心：${state}\n`
              } catch {
                // not a git hub or git missing — skip the line silently
              }
              // Approval reminder (S2 gap from the S1 pilot): pending proposals
              // need a human — surface the count every session start so the
              // model actively tells the user when review is owed.
              let pendingLine = ''
              try {
                const pendingCount = hub.listProposals(hubCtx.root).length
                if (pendingCount > 0) pendingLine = `待审批 ${pendingCount} 条提案（memhub inbox list 查看；面板 127.0.0.1:7777 也可审）\n`
              } catch {
                // hub read failed — keep the snapshot going without the line
              }
              const pack = hub.preflight(hubCtx.index, hubCtx.root, hubCtx.workspace.workspaceId, intent, {
                teamId: process.env['MEMHUB_TEAM'],
              })
              const hits = pack.hits ?? []
              const lines = hits.map((hit: { id: string; title: string; abstract?: string }) => `- ${hit.id} ${hit.title}${hit.abstract ? `：${hit.abstract}` : ''}`)
              lastText = `${liveness}${pendingLine}` + (lines.length === 0
                ? '（记忆中枢：本意图暂无命中。会话收尾时若有可沉淀知识，用 memory_propose 提交、memory_close_task 关闭任务——有实质 note 的 close 会自动生成待审提案。）'
                : `【记忆中枢快照 · 意图：${intent}】开始工作前可参考：\n${lines.join('\n')}\n（详情用 memory_get；标 key: true 的条目会永远伴随注入。会话收尾时用 memory_propose 提交新知识、memory_close_task 关闭任务——有实质 note 的 close 自动生成待审提案。）`)
            } catch (error) {
              lastText = ''
              ctx.logger?.warn(`agent-memory-hub-dsh: preflight snapshot failed: ${error instanceof Error ? error.message : String(error)}`)
            }
            return lastText
          },
        })
        if (typeof dispose === 'function') {
          ctx.effect?.(() => dispose, `${name}-snapshot`)
        }
        ctx.logger?.info('agent-memory-hub-dsh: session snapshot hook registered (start-query + end-commit guidance)')
      } catch (error) {
        ctx.logger?.warn(`agent-memory-hub-dsh: systemPrompt hook unavailable: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    disposersSystem()
  }
  ctx.effect?.(() => () => {
    for (const dispose of disposers) dispose()
  }, name)
}
