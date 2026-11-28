import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite } from './atomic.js'

/**
 * Scheduled distillation: configuration + run records (ADR-0031).
 *
 * The hub never owns a model. Distillation is therefore split in two halves:
 *
 *   hub side (this module) — WHERE the schedule lives, WHEN it is next due,
 *     WHICH window an extraction covers, and WHAT each run produced. All of
 *     it is plain JSON under `records/distill/` (machine-local state, already
 *     gitignored).
 *   host side (skill) — the actual LLM distilling, driven by any scheduler
 *     (ADR-0011 stayed trigger-agnostic).
 *
 * Design constraints taken from the research reports:
 *   - the schedule is CONFIG DATA, never a cron string the UI has to parse
 *     (research-distill-practice §10.1)
 *   - a run has its own identity, so "this batch" can be reviewed, re-run and
 *     rolled back as a unit (research-distill-frameworks §9)
 *   - `autoPromote` defaults to false: the human gate is not bypassed unless
 *     the operator explicitly opts in
 */

export const DISTILL_DIR = 'distill'
export const DISTILL_CONFIG_FILE = 'config.json'

export type DistillMode = 'daily' | 'weekly' | 'interval'
export type MissedPolicy = 'merge' | 'skip'
export type ConcurrencyPolicy = 'forbid' | 'replace'

export interface DistillSchedule {
  mode: DistillMode
  /** Weekly only: ISO weekday names, e.g. ['MO','WE']. */
  days?: string[]
  /** Daily/weekly: local wall-clock time 'HH:mm'. */
  at?: string
  /** IANA time zone, e.g. 'Asia/Shanghai'. */
  timezone: string
  /** Interval mode only: hours between runs. */
  intervalHours?: number
}

export interface DistillConfig {
  enabled: boolean
  schedule: DistillSchedule
  window: { maxHours: number; maxEvents: number }
  batch: { maxCandidates: number; shardEvents: number }
  missed: { policy: MissedPolicy; maxCatchupDays: number; concurrency: ConcurrencyPolicy }
  trust: { autoPromote: boolean; autoPromoteTypes: string[]; dailyAutoCap: number; autoTtlDays: number }
  notify: { onFailure: boolean; zeroOutputAlertAfter: number }
}

export type DistillRunStatus = 'planned' | 'extracting' | 'staged' | 'reviewing' | 'closed' | 'abandoned' | 'failed'

export interface DistillRunCounts {
  candidates: number
  proposed: number
  approved: number
  rejected: number
  deferred: number
  autoPromoted: number
}

export interface DistillRun {
  id: string
  status: DistillRunStatus
  /** 'schedule' | 'manual' | 'catchup' */
  trigger: string
  startedAt: string
  finishedAt?: string
  durationMs?: number
  /** Event-id window this run covers (research §9.3: event ids, not just timestamps). */
  window: { from: string; to: string; maxHours: number; maxEvents: number }
  model?: string
  promptVersion: string
  counts: DistillRunCounts
  watermarkBefore: string
  watermarkAfter?: string
  error?: string
  notes?: string
}

export const DISTILL_PROMPT_VERSION = 'distill-v1'
/** Runs older than this keep their terminal status; a 'running' one is stale. */
export const RUN_STALE_MS = 6 * 3600_000
/** Research §10.2: quality degrades once the review queue passes ~50 items. */
export const QUEUE_PRESSURE = 50

export function distillDir(root: string): string {
  return join(root, 'records', DISTILL_DIR)
}

export function distillConfigPath(root: string): string {
  return join(distillDir(root), DISTILL_CONFIG_FILE)
}

export function distillRunsDir(root: string): string {
  return join(distillDir(root), 'runs')
}

export function defaultDistillConfig(): DistillConfig {
  return {
    enabled: false,
    schedule: { mode: 'weekly', days: ['MO'], at: '09:00', timezone: 'Asia/Shanghai' },
    window: { maxHours: 72, maxEvents: 500 },
    batch: { maxCandidates: 30, shardEvents: 200 },
    missed: { policy: 'merge', maxCatchupDays: 7, concurrency: 'forbid' },
    // autoPromote stays OFF by default: "审核以后方可入库" is the product rule.
    trust: { autoPromote: false, autoPromoteTypes: ['knowledge', 'assets'], dailyAutoCap: 5, autoTtlDays: 90 },
    notify: { onFailure: true, zeroOutputAlertAfter: 2 },
  }
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Merge a partial config over the defaults, validating every field. */
export function normalizeDistillConfig(input: unknown): DistillConfig {
  const base = defaultDistillConfig()
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const sched = (typeof raw['schedule'] === 'object' && raw['schedule'] !== null ? raw['schedule'] : {}) as Record<string, unknown>
  const win = (typeof raw['window'] === 'object' && raw['window'] !== null ? raw['window'] : {}) as Record<string, unknown>
  const batch = (typeof raw['batch'] === 'object' && raw['batch'] !== null ? raw['batch'] : {}) as Record<string, unknown>
  const missed = (typeof raw['missed'] === 'object' && raw['missed'] !== null ? raw['missed'] : {}) as Record<string, unknown>
  const trust = (typeof raw['trust'] === 'object' && raw['trust'] !== null ? raw['trust'] : {}) as Record<string, unknown>
  const notify = (typeof raw['notify'] === 'object' && raw['notify'] !== null ? raw['notify'] : {}) as Record<string, unknown>

  const modeRaw = sched['mode']
  const mode: DistillMode = modeRaw === 'daily' || modeRaw === 'weekly' || modeRaw === 'interval' ? modeRaw : base.schedule.mode
  const atRaw = typeof sched['at'] === 'string' ? sched['at'] : base.schedule.at
  const at = typeof atRaw === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(atRaw) ? atRaw : base.schedule.at
  const daysRaw = Array.isArray(sched['days']) ? (sched['days'] as unknown[]).map(String) : base.schedule.days
  const validDay = /^(MO|TU|WE|TH|FR|SA|SU)$/
  const days = (daysRaw ?? []).filter((d) => validDay.test(d))
  const timezone = typeof sched['timezone'] === 'string' && sched['timezone'].trim() !== '' ? sched['timezone'].trim() : base.schedule.timezone

  return {
    enabled: bool(raw['enabled'], base.enabled),
    schedule: {
      mode,
      days: days.length > 0 ? days : base.schedule.days,
      at,
      timezone,
      intervalHours: mode === 'interval' ? num(sched['intervalHours'], 24, 1, 24 * 30) : undefined,
    },
    window: {
      maxHours: num(win['maxHours'], base.window.maxHours, 1, 24 * 90),
      maxEvents: num(win['maxEvents'], base.window.maxEvents, 1, 100_000),
    },
    batch: {
      // Cap the per-run candidate count at the review-fatigue threshold.
      maxCandidates: num(batch['maxCandidates'], base.batch.maxCandidates, 1, QUEUE_PRESSURE),
      shardEvents: num(batch['shardEvents'], base.batch.shardEvents, 10, 100_000),
    },
    missed: {
      policy: missed['policy'] === 'skip' ? 'skip' : 'merge',
      maxCatchupDays: num(missed['maxCatchupDays'], base.missed.maxCatchupDays, 0, 90),
      concurrency: missed['concurrency'] === 'replace' ? 'replace' : 'forbid',
    },
    trust: {
      autoPromote: bool(trust['autoPromote'], base.trust.autoPromote),
      autoPromoteTypes: Array.isArray(trust['autoPromoteTypes'])
        ? (trust['autoPromoteTypes'] as unknown[]).map(String)
        : base.trust.autoPromoteTypes,
      dailyAutoCap: num(trust['dailyAutoCap'], base.trust.dailyAutoCap, 0, 100),
      autoTtlDays: num(trust['autoTtlDays'], base.trust.autoTtlDays, 0, 3650),
    },
    notify: {
      onFailure: bool(notify['onFailure'], base.notify.onFailure),
      zeroOutputAlertAfter: num(notify['zeroOutputAlertAfter'], base.notify.zeroOutputAlertAfter, 0, 100),
    },
  }
}

export function readDistillConfig(root: string): DistillConfig {
  const path = distillConfigPath(root)
  if (!existsSync(path)) return defaultDistillConfig()
  try {
    return normalizeDistillConfig(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return defaultDistillConfig()
  }
}

export function writeDistillConfig(root: string, input: unknown): DistillConfig {
  const config = normalizeDistillConfig(input)
  const dir = distillDir(root)
  mkdirSync(dir, { recursive: true })
  atomicWrite(distillConfigPath(root), JSON.stringify(config, null, 2) + '\n')
  return config
}

// ── time-zone aware scheduling ────────────────────────────────────────────

/** Offset of `tz` wall clock from UTC at instant `date`, in ms. */
function tzOffsetMs(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts: Record<string, string> = {}
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = p.value
  }
  const hour = Number(parts['hour'] ?? '0') % 24
  const asUtc = Date.UTC(
    Number(parts['year'] ?? '1970'),
    Number(parts['month'] ?? '1') - 1,
    Number(parts['day'] ?? '1'),
    hour,
    Number(parts['minute'] ?? '0'),
    Number(parts['second'] ?? '0'),
  )
  return asUtc - date.getTime()
}

/** Build a UTC instant from a wall-clock time in `tz` (DST-safe by iteration). */
function wallToUtc(tz: string, y: number, m: number, d: number, hh: number, mm: number): number {
  const wallAsUtc = Date.UTC(y, m - 1, d, hh, mm, 0)
  let ts = wallAsUtc
  for (let i = 0; i < 3; i += 1) {
    ts = wallAsUtc - tzOffsetMs(new Date(ts), tz)
  }
  return ts
}

const WEEKDAY_INDEX: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }

/** Local calendar parts of an instant in `tz`. */
function zonedDateParts(date: Date, tz: string): { y: number; m: number; d: number; weekday: number } {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit' })
  const parts: Record<string, string> = {}
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = p.value
  }
  const wd = (parts['weekday'] ?? 'Sun').slice(0, 2).toUpperCase()
  return {
    y: Number(parts['year'] ?? '1970'),
    m: Number(parts['month'] ?? '1'),
    d: Number(parts['day'] ?? '1'),
    weekday: WEEKDAY_INDEX[wd] ?? 0,
  }
}

/** Most recent trigger instant at or before `from`, or null when none landed yet. */
export function previousTriggerAt(config: DistillConfig, from: Date): string | null {
  const { schedule } = config
  const tz = schedule.timezone
  if (schedule.mode === 'interval') {
    // Interval without a previous run has no anchor — treat "now" as due.
    return null
  }
  const at = schedule.at ?? '09:00'
  const [hh, mm] = at.split(':').map(Number) as [number, number]
  const wanted = schedule.mode === 'weekly' ? new Set((schedule.days ?? ['MO']).map((d) => WEEKDAY_INDEX[d] ?? 1)) : null
  const start = zonedDateParts(from, tz)
  for (let offset = 0; offset >= -400; offset -= 1) {
    const probe = new Date(Date.UTC(start.y, start.m - 1, start.d + offset, 12, 0, 0))
    const parts = zonedDateParts(probe, tz)
    if (wanted !== null && !wanted.has(parts.weekday)) continue
    const candidate = wallToUtc(tz, parts.y, parts.m, parts.d, hh, mm)
    if (candidate <= from.getTime()) return new Date(candidate).toISOString()
  }
  return null
}

/**
 * Next trigger instant (ISO) strictly after `from`.
 * Returns null when the schedule can never fire (interval mode without a base).
 */
export function nextTriggerAt(config: DistillConfig, from: Date, lastRunAt?: string): string | null {
  const { schedule } = config
  const tz = schedule.timezone
  if (schedule.mode === 'interval') {
    const hours = schedule.intervalHours ?? 24
    const anchor = lastRunAt !== undefined && lastRunAt !== '' ? Date.parse(lastRunAt) : NaN
    const base = Number.isNaN(anchor) ? from.getTime() : anchor
    return new Date(base + hours * 3600_000).toISOString()
  }
  const at = schedule.at ?? '09:00'
  const [hh, mm] = at.split(':').map(Number) as [number, number]
  const wanted = schedule.mode === 'weekly' ? new Set((schedule.days ?? ['MO']).map((d) => WEEKDAY_INDEX[d] ?? 1)) : null
  const start = zonedDateParts(from, tz)
  for (let offset = 0; offset <= 400; offset += 1) {
    const probe = new Date(Date.UTC(start.y, start.m - 1, start.d + offset, 12, 0, 0))
    const parts = zonedDateParts(probe, tz)
    if (wanted !== null && !wanted.has(parts.weekday)) continue
    const candidate = wallToUtc(tz, parts.y, parts.m, parts.d, hh, mm)
    if (candidate > from.getTime()) return new Date(candidate).toISOString()
  }
  return null
}

// ── run records ───────────────────────────────────────────────────────────

export function newRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  const rand = Math.random().toString(36).slice(2, 6)
  return `RUN-${stamp}-${rand}`
}

export function emptyRunCounts(): DistillRunCounts {
  return { candidates: 0, proposed: 0, approved: 0, rejected: 0, deferred: 0, autoPromoted: 0 }
}

function runPath(root: string, id: string): string {
  return join(distillRunsDir(root), `${id}.json`)
}

export function writeRun(root: string, run: DistillRun): DistillRun {
  const dir = distillRunsDir(root)
  mkdirSync(dir, { recursive: true })
  atomicWrite(runPath(root, run.id), JSON.stringify(run, null, 2) + '\n')
  return run
}

export function readRun(root: string, id: string): DistillRun | null {
  const path = runPath(root, id)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as DistillRun
  } catch {
    return null
  }
}

/** Runs newest-first. */
export function listRuns(root: string, limit = 20): DistillRun[] {
  const dir = distillRunsDir(root)
  if (!existsSync(dir)) return []
  const runs: DistillRun[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    try {
      runs.push(JSON.parse(readFileSync(join(dir, file), 'utf8')) as DistillRun)
    } catch {
      // skip unreadable run record
    }
  }
  runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
  return runs.slice(0, limit)
}

/** A run that claims to be in flight but clearly died. */
export function isRunStale(run: DistillRun, now = Date.now()): boolean {
  const active = run.status === 'planned' || run.status === 'extracting' || run.status === 'staged' || run.status === 'reviewing'
  if (!active) return false
  const started = Date.parse(run.startedAt)
  return !Number.isNaN(started) && now - started > RUN_STALE_MS
}

export interface DistillStatus {
  config: DistillConfig
  /** ISO of the next scheduled trigger, or null when disabled/unschedulable. */
  nextAt: string | null
  due: boolean
  /** Why it is not due (empty when due). */
  reasons: string[]
  lastRun: DistillRun | null
  /** Runs whose status says "in flight" right now. */
  inflight: DistillRun | null
  /** Consecutive completed runs that produced zero proposals (silent-failure signal). */
  zeroOutputStreak: number
  /** Pending distill proposals waiting for the second review queue. */
  queueDepth: number
}

/**
 * Decide whether a scheduled run should fire now. Pure read.
 *
 * Order matters: disabled → in-flight (concurrency forbid) → queue pressure →
 * schedule. Every refusal carries a human-readable reason so the panel can
 * explain itself instead of silently doing nothing.
 */
export function computeDistillStatus(
  root: string,
  options: { now?: Date; queueDepth?: number; pendingTitles?: string[] } = {},
): DistillStatus {
  const now = options.now ?? new Date()
  const config = readDistillConfig(root)
  const runs = listRuns(root, 50)
  const lastCompleted = runs.find((r) => r.status === 'closed' || r.status === 'failed' || r.status === 'abandoned') ?? null
  const inflightRun = runs.find((r) => isRunStale(r, now.getTime()) === false && ['planned', 'extracting', 'staged', 'reviewing'].includes(r.status)) ?? null
  const queueDepth = options.queueDepth ?? 0

  let zeroOutputStreak = 0
  for (const r of runs) {
    if (r.status !== 'closed') {
      if (r.status === 'failed' || r.status === 'abandoned') continue
      continue
    }
    if (r.counts.proposed === 0) zeroOutputStreak += 1
    else break
  }

  const nextAt = config.enabled ? nextTriggerAt(config, now, lastCompleted?.startedAt) : null
  const lastDueAt = config.enabled ? previousTriggerAt(config, now) : null
  const reasons: string[] = []
  let due = false

  if (!config.enabled) {
    reasons.push('调度未启用')
  } else if (config.missed.concurrency === 'forbid' && inflightRun !== null) {
    reasons.push(`已有运行在进行中（${inflightRun.id}）`)
  } else if (queueDepth >= QUEUE_PRESSURE) {
    // Backpressure: reduce generation instead of nagging the reviewer.
    reasons.push(`蒸馏审核队列积压 ${queueDepth} 条（阈值 ${QUEUE_PRESSURE}），先清理再生成`)
  } else if (lastDueAt === null) {
    // Interval mode with no anchor, or a schedule that never lands.
    due = true
  } else if (lastCompleted === null) {
    // Nothing has ever run and the schedule already came up: catch up once.
    due = true
  } else {
    // Due when the last completed run started before the most recent
    // scheduled instant (i.e. that occurrence has not been served yet).
    const gapDays = (Date.parse(lastDueAt) - Date.parse(lastCompleted.startedAt)) / 86_400_000
    if (gapDays > config.missed.maxCatchupDays) {
      // Too far behind to be worth a catch-up: report it instead of silently
      // extracting a huge backlog (research: bounded catch-up).
      reasons.push(`错过补偿超期 ${Math.floor(gapDays)} 天（上限 ${config.missed.maxCatchupDays} 天），请手动触发`)
    } else {
      due = lastCompleted.startedAt < lastDueAt
      if (!due) reasons.push(`本轮已完成（下次 ${nextAt ?? '—'}）`)
    }
  }

  return { config, nextAt, due, reasons, lastRun: lastCompleted, inflight: inflightRun, zeroOutputStreak, queueDepth }
}
