/** ISO-8601 timestamps with local offset, matching the predecessor's format
 * (e.g. 2026-11-15T16:41:52+08:00). All persisted timestamps use this shape. */

export function nowIso(): string {
  return new Date().toISOString().replace('Z', offsetString(new Date()))
}

function offsetString(date: Date): string {
  const minutes = -date.getTimezoneOffset()
  const sign = minutes >= 0 ? '+' : '-'
  const abs = Math.abs(minutes)
  const hh = String(Math.floor(abs / 60)).padStart(2, '0')
  const mm = String(abs % 60).padStart(2, '0')
  return `${sign}${hh}:${mm}`
}

/** Parse an ISO timestamp; returns epoch ms, or null when invalid/missing. */
export function parseIso(value: string | undefined): number | null {
  if (value === undefined || value === '') return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}
