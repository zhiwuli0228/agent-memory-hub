import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'
import { ErrorCode, HubError } from './errors.js'

/**
 * Atomic write: write to a temp file in the same directory, then rename over
 * the target. Same-directory rename is atomic on NTFS/ext4/APFS. Never write
 * the final path directly (storage contract, rule 1).
 */
export function atomicWrite(filePath: string, content: string): void {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })
  const base = parse(filePath).name
  const tmp = join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`)
  try {
    writeFileSync(tmp, content, 'utf8')
    // Windows rename over an existing file fails; remove first (tiny window,
    // acceptable for a single-writer-locked store).
    try {
      rmSync(filePath, { force: true })
    } catch {
      // target did not exist
    }
    renameSync(tmp, filePath)
  } catch (error) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // best effort cleanup
    }
    const detail = error instanceof Error ? error.message : String(error)
    throw new HubError(ErrorCode.E_VALIDATION, `atomic write failed for ${filePath}: ${detail}`)
  }
}
