/**
 * Public surface of agent-memory-hub. Host packages (the DSH thin adapter,
 * CLIs, panels) import ONLY from this barrel — never deep paths — so the
 * internal layout can move without breaking hosts.
 */

// Types
export type {
  KnowledgeType,
  KnowledgeStatus,
  KnowledgeScope,
  KnowledgeFrontmatter,
} from './core/types.js'
export type { Sequences } from './core/ids.js'
export type { LedgerAction, LedgerRecord } from './core/ledger.js'
export type { WriterLock, LockOptions, AcquireResult } from './core/lock.js'
export type { SaveKnowledgeInput, KnowledgeEntry } from './core/store.js'
export type { SearchHit, SearchIndex, SearchMetrics, SearchOptions, DetailLevel } from './core/search.js'
export type { PreflightResult, PreflightOptions } from './core/inject.js'
export type { JournalEntry, AppendJournalInput } from './core/journal.js'
export type { TranscriptRecord, DejaVu } from './core/transcript.js'
export type { ApprovalChannel } from './core/approval.js'

// Errors
export { ErrorCode, HubError } from './core/errors.js'

// Time + ids
export { nowIso, parseIso } from './core/time.js'
export { newLockToken } from './core/ids.js'

// Hub lifecycle
export {
  HUB_DIRS,
  KNOWLEDGE_TYPES_DIR,
  HUB_CONFIG,
  HUB_README,
  LEDGER_FILE,
  SEQUENCES_FILE,
  LOCK_FILE,
  isHubInitialized,
  initHub,
  readHubConfig,
  knowledgeDir,
  historyDir,
  pendingDir,
  journalDir,
} from './core/hub.js'

// Atomic writes
export { atomicWrite } from './core/atomic.js'

// Ledger + sequences
export { appendLedger, ledgerPath, readLedger, readSequences, writeSequences } from './core/ledger.js'

// Store
export {
  commitKnowledge,
  createProposal,
  deprecateEntry,
  hardDeleteEntry,
  findTitleConflict,
  getEntry,
  listEntries,
  listProposals,
  renderKnowledgeMarkdown,
} from './core/store.js'

// Registry (ADR-0002 zero-config identity)
export {
  resolveWorkspace,
  registerWorkspace,
  readRegisteredWorkspaces,
  slugifyDir,
  workspaceIdFromOrigin,
} from './core/registry.js'
export type { ResolvedWorkspace } from './core/registry.js'

// Lock
export { acquireLock, heartbeatLock, releaseLock, assertFencing, isLockFresh, lockInfo, readLock } from './core/lock.js'

// Search
export { buildIndex, search, searchWithMetrics, emptyMetrics, tokenize, isVisible } from './core/search.js'

// Preflight / injection
export { preflight, preflightIndex, renderPack, estimateTokens } from './core/inject.js'

// Approval gate
export { requireApproval, isHumanChannel, HUMAN_CHANNELS } from './core/approval.js'

// Journal
export { appendJournal, readJournal, trimJournal } from './core/journal.js'

// Transcript (deja-vu)
export {
  indexTranscript,
  readTranscriptIndex,
  detectDejaVu,
  rebuildTranscriptIndex,
  TRANSCRIPT_INDEX_FILE,
} from './core/transcript.js'
