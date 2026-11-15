import { ErrorCode, HubError } from './errors.js'

/**
 * ApprovalPort — the code-level gate for invariant 2 (humans approve; models
 * propose). A write into knowledge/ must name the channel that carried the
 * human approval. Channels without a human (mcp-model) fail closed with
 * E_APPROVAL_REQUIRED; the attempt is recorded as approval.missing so the
 * failure is auditable, not silent.
 */

export type ApprovalChannel =
  /** Human ran the CLI inbox command. */
  | 'cli-human'
  /** Human clicked approve in the serve panel. */
  | 'panel'
  /** Future DSH native approval prompt. */
  | 'host-prompt'
  /** A model asking to commit directly — never carries approval. */
  | 'mcp-model'

export const HUMAN_CHANNELS: readonly ApprovalChannel[] = ['cli-human', 'panel', 'host-prompt']

export function isHumanChannel(channel: ApprovalChannel): boolean {
  return HUMAN_CHANNELS.includes(channel)
}

/** Throw E_APPROVAL_REQUIRED unless the channel is human-carried. */
export function requireApproval(
  channel: ApprovalChannel,
  context: { id: string; ledgerAppend?: (record: Record<string, unknown>) => void },
): void {
  if (isHumanChannel(channel)) return
  context.ledgerAppend?.({
    type: 'approval.missing',
    id: context.id,
    channel,
    at: new Date().toISOString(),
  })
  throw new HubError(
    ErrorCode.E_APPROVAL_REQUIRED,
    'commit requires human approval — use the panel inbox or `memhub inbox approve <ID>`',
    { id: context.id, channel },
  )
}
