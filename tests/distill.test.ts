import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { initHub } from '../src/core/hub.js'
import {
  DISTILL_PROMPT_VERSION,
  QUEUE_PRESSURE,
  computeDistillStatus,
  defaultDistillConfig,
  emptyRunCounts,
  isRunStale,
  listRuns,
  newRunId,
  nextTriggerAt,
  normalizeDistillConfig,
  readDistillConfig,
  readRun,
  writeDistillConfig,
  writeRun,
  type DistillRun,
} from '../src/core/distill.js'

function freshHub(): string {
  const root = mkdtempSync(join(tmpdir(), 'amh-distill-'))
  initHub(root)
  return root
}

function run(root: string, overrides: Partial<DistillRun> = {}): DistillRun {
  const base: DistillRun = {
    id: newRunId(),
    status: 'staged',
    trigger: 'manual',
    startedAt: '2026-11-29T01:00:00.000Z',
    promptVersion: DISTILL_PROMPT_VERSION,
    window: { from: '', to: '2026-11-29T01:00:00.000Z', maxHours: 72, maxEvents: 500 },
    counts: emptyRunCounts(),
    watermarkBefore: '',
    ...overrides,
  }
  return writeRun(root, base)
}

describe('distill config (ADR-0031: schedule is config data, not a cron string)', () => {
  it('defaults are conservative: disabled, weekly Monday 09:00, autoPromote off', () => {
    const config = defaultDistillConfig()
    expect(config.enabled).toBe(false)
    expect(config.schedule.mode).toBe('weekly')
    expect(config.schedule.days).toEqual(['MO'])
    expect(config.schedule.at).toBe('09:00')
    expect(config.schedule.timezone).toBe('Asia/Shanghai')
    // The product rule is "approve before landing" — auto-promotion is opt-in.
    expect(config.trust.autoPromote).toBe(false)
    // Concurrency is forbidden so two runs cannot fight over the watermark.
    expect(config.missed.concurrency).toBe('forbid')
  })

  it('normalize clamps hostile input instead of trusting the panel', () => {
    const config = normalizeDistillConfig({
      enabled: 'yes', // not a boolean -> stays default false
      schedule: { mode: 'nonsense', at: '25:99', days: ['XX', 'MO'], timezone: '  ' },
      window: { maxHours: 99_999, maxEvents: 0 },
      batch: { maxCandidates: 9999 },
      trust: { dailyAutoCap: -5 },
    })
    expect(config.enabled).toBe(false)
    expect(config.schedule.mode).toBe('weekly') // invalid mode falls back
    expect(config.schedule.at).toBe('09:00') // invalid HH:mm falls back
    expect(config.schedule.days).toEqual(['MO']) // only valid weekdays survive
    expect(config.schedule.timezone).toBe('Asia/Shanghai') // blank falls back
    expect(config.window.maxHours).toBe(24 * 90) // clamped to the ceiling
    expect(config.window.maxEvents).toBe(1) // clamped to the floor
    // Candidate count may never exceed the review-fatigue threshold.
    expect(config.batch.maxCandidates).toBe(QUEUE_PRESSURE)
    expect(config.trust.dailyAutoCap).toBe(0)
  })

  it('config round-trips through records/distill/config.json', () => {
    const root = freshHub()
    expect(readDistillConfig(root).enabled).toBe(false) // absent file -> defaults
    const saved = writeDistillConfig(root, { enabled: true, schedule: { mode: 'daily', at: '07:30', timezone: 'Asia/Shanghai' } })
    expect(saved.enabled).toBe(true)
    const read = readDistillConfig(root)
    expect(read.enabled).toBe(true)
    expect(read.schedule.mode).toBe('daily')
    expect(read.schedule.at).toBe('07:30')
  })
})

describe('distill scheduling: next trigger in the configured time zone', () => {
  const weekly = normalizeDistillConfig({ enabled: true, schedule: { mode: 'weekly', days: ['MO'], at: '09:00', timezone: 'Asia/Shanghai' } })

  it('weekly Monday 09:00 Asia/Shanghai resolves to Monday 01:00Z', () => {
    // 2026-11-29T04:00Z is Sunday 12:00 in Shanghai -> next Monday 09:00 local.
    const next = nextTriggerAt(weekly, new Date('2026-11-29T04:00:00.000Z'))
    expect(next).toBe('2026-11-30T01:00:00.000Z')
  })

  it('a trigger already in the past rolls to the next occurrence', () => {
    // Monday 10:00 local (02:00Z) is past that day's 09:00 -> next Monday.
    const next = nextTriggerAt(weekly, new Date('2026-11-30T02:00:00.000Z'))
    expect(next).toBe('2026-12-07T01:00:00.000Z')
  })

  it('daily honours the wall-clock time and the time zone', () => {
    const daily = normalizeDistillConfig({ enabled: true, schedule: { mode: 'daily', at: '07:30', timezone: 'Asia/Shanghai' } })
    const next = nextTriggerAt(daily, new Date('2026-11-29T04:00:00.000Z'))
    // 07:30 Shanghai == 2026-11-28T23:30Z; from 04:00Z the next one is 11-29 23:30Z.
    expect(next).toBe('2026-11-29T23:30:00.000Z')
  })

  it('interval mode counts from the last run', () => {
    const interval = normalizeDistillConfig({ enabled: true, schedule: { mode: 'interval', intervalHours: 6, timezone: 'UTC' } })
    const next = nextTriggerAt(interval, new Date('2026-11-29T04:00:00.000Z'), '2026-11-29T01:00:00.000Z')
    expect(next).toBe('2026-11-29T07:00:00.000Z')
  })
})

describe('distill status: due / not-due with an explanatory reason', () => {
  it('disabled means never due, and says so', () => {
    const root = freshHub()
    const status = computeDistillStatus(root, { now: new Date('2026-11-30T05:00:00.000Z') })
    expect(status.due).toBe(false)
    expect(status.nextAt).toBeNull()
    expect(status.reasons.join()).toContain('未启用')
  })

  it('a passed instant with no prior run catches up (never ran -> due)', () => {
    const root = freshHub()
    writeDistillConfig(root, { enabled: true, schedule: { mode: 'weekly', days: ['MO'], at: '09:00', timezone: 'Asia/Shanghai' } })
    // Monday 08:59 local: the schedule has come up many times and never ran.
    const before = computeDistillStatus(root, { now: new Date('2026-11-30T00:59:00.000Z') })
    expect(before.due).toBe(true)
    expect(before.nextAt).toBe('2026-11-30T01:00:00.000Z')
    // Monday 09:00:01 local: still due (the 09:00 occurrence is unserved).
    const after = computeDistillStatus(root, { now: new Date('2026-11-30T01:00:01.000Z') })
    expect(after.due).toBe(true)
  })

  it('an occurrence already served by a completed run is not due again', () => {
    const root = freshHub()
    writeDistillConfig(root, { enabled: true, schedule: { mode: 'weekly', days: ['MO'], at: '09:00', timezone: 'Asia/Shanghai' } })
    // The run started AFTER Monday 09:00 local, so that occurrence is served.
    run(root, { status: 'closed', startedAt: '2026-11-30T02:00:00.000Z' })
    const status = computeDistillStatus(root, { now: new Date('2026-11-30T05:00:00.000Z') })
    expect(status.due).toBe(false)
    expect(status.reasons.join()).toContain('本轮已完成')
  })

  it('queue pressure blocks generation instead of nagging the reviewer', () => {
    const root = freshHub()
    writeDistillConfig(root, { enabled: true, schedule: { mode: 'daily', at: '00:00', timezone: 'UTC' } })
    const status = computeDistillStatus(root, { now: new Date('2026-11-30T05:00:00.000Z'), queueDepth: QUEUE_PRESSURE })
    expect(status.due).toBe(false)
    expect(status.reasons.join()).toContain('积压')
  })

  it('an in-flight run blocks a second run (concurrency forbid)', () => {
    const root = freshHub()
    writeDistillConfig(root, { enabled: true, schedule: { mode: 'daily', at: '00:00', timezone: 'UTC' } })
    const now = new Date()
    run(root, { status: 'extracting', startedAt: now.toISOString() })
    const status = computeDistillStatus(root, { now })
    expect(status.due).toBe(false)
    expect(status.inflight).not.toBeNull()
    expect(status.reasons.join()).toContain('进行中')
  })

  it('counts consecutive zero-output runs (the silent-failure signal)', () => {
    const root = freshHub()
    run(root, { status: 'closed', startedAt: '2026-11-29T03:00:00.000Z' })
    run(root, { status: 'closed', startedAt: '2026-11-29T02:00:00.000Z' })
    const status = computeDistillStatus(root, { now: new Date('2026-11-30T05:00:00.000Z') })
    expect(status.zeroOutputStreak).toBe(2)
  })
})

describe('distill run records: each extraction has an identity', () => {
  it('write / read / list round-trip, newest first', () => {
    const root = freshHub()
    run(root, { startedAt: '2026-11-29T01:00:00.000Z' })
    run(root, { startedAt: '2026-11-29T03:00:00.000Z' })
    const runs = listRuns(root)
    expect(runs.length).toBe(2)
    expect(runs[0]?.startedAt).toBe('2026-11-29T03:00:00.000Z')
  })

  it('records the full provenance the reviewer needs', () => {
    const root = freshHub()
    const written = run(root, { model: 'deepseek-v4-flash', counts: { ...emptyRunCounts(), candidates: 12, proposed: 5, rejected: 7 } })
    const read = readRun(root, written.id)
    expect(read?.model).toBe('deepseek-v4-flash')
    expect(read?.promptVersion).toBe(DISTILL_PROMPT_VERSION)
    expect(read?.counts.candidates).toBe(12)
    expect(read?.counts.proposed).toBe(5)
    expect(read?.counts.rejected).toBe(7)
  })

  it('unknown run ids read as null instead of throwing', () => {
    const root = freshHub()
    expect(readRun(root, 'RUN-00000000000000-zzzz')).toBeNull()
  })

  it('a run stuck in flight long past the deadline is stale', () => {
    const stale: DistillRun = {
      id: 'RUN-x',
      status: 'extracting',
      trigger: 'schedule',
      startedAt: new Date(Date.now() - 8 * 3600_000).toISOString(),
      promptVersion: DISTILL_PROMPT_VERSION,
      window: { from: '', to: '', maxHours: 72, maxEvents: 500 },
      counts: emptyRunCounts(),
      watermarkBefore: '',
    }
    expect(isRunStale(stale)).toBe(true)
    expect(isRunStale({ ...stale, status: 'closed' })).toBe(false)
    expect(isRunStale({ ...stale, startedAt: new Date().toISOString() })).toBe(false)
  })
})
