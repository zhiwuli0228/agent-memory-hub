/**
 * Minimal structural types for the DSH host surface the adapter touches.
 * Declared here (not imported from the host SDK) so the adapter has zero
 * host dependencies at build time — the host provides these capabilities.
 */

export interface ContentBlock {
  type: 'text'
  text: string
}

export interface ToolOutput {
  schema: Record<string, unknown>
  render: (args: unknown, value: unknown) => ContentBlock[]
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  /** Host contract: every tool declares its output shape + renderer. */
  output: ToolOutput
  isConcurrencySafe?: () => boolean
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown> | unknown
}

export function renderJson(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

export interface HostContext {
  tools: {
    get(name: string): ToolDefinition | undefined
    register(tool: ToolDefinition): () => void
  }
  /**
   * systemPrompt service (declared via `inject`). context() registers a
   * dynamic tail message; DSH materializes it as a user-role tail and only
   * re-appends when the rendered text changes. Missing in bare hosts —
   * registration is wrapped in try/catch at the call site.
   */
  systemPrompt?: {
    context(options: {
      name: string
      order?: number
      text(context: { agent?: { session?: { header?: { cwd?: string } } } }): string
    }): () => void
  }
  logger?: {
    info(message: string): void
    warn(message: string): void
  }
  effect?(dispose: () => () => void, name?: string): void
}

export interface AdapterConfig {
  /** Hub root directory. Empty/missing = $MEMHUB_ROOT or the process cwd. */
  root?: string
  /**
   * What to do when a tool name is already registered (host or another
   * plugin — e.g. the predecessor dsh-memory-hub): 'skip' (default) drops
   * ours and keeps the existing one; 'suffix' renames ours to `<name>__amh`.
   */
  toolConflict?: 'skip' | 'suffix'
  /**
   * Panel HTTP port (ADR-0012). Defaults to 7777, or $DSH_AMH_PANEL_PORT.
   * Multiple DSH profiles (e.g. desktop + web on the same machine) must not
   * share the port — configure a distinct value per profile.
   */
  panelPort?: number
}

export function resolveHubRoot(config?: AdapterConfig): string {
  const explicit = config?.root
  if (explicit !== undefined && explicit !== '') return explicit
  return process.env['MEMHUB_ROOT'] ?? process.cwd()
}
