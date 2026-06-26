import { rm } from 'node:fs/promises'

// `Bun.gc(true)` is load-bearing, not suppression: bun:sqlite holds the DB file
// handle open past `db.close()` until the Statement wrappers are finalized (Bun
// #25964), and on Windows that open handle pins the dir so `rm` throws EBUSY.
// The forced GC runs those finalizers. Bun ignores `fs.rm`'s maxRetries, so the
// loop covers the brief window a sibling worker / just-exited subprocess needs.
const RETRIES = 10
const RETRY_DELAY_MS = 50
const RETRYABLE = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY'])

export async function rmTempDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    Bun.gc(true)
    try {
      await rm(dir, { recursive: true, force: true })
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt === RETRIES || code === undefined || !RETRYABLE.has(code)) throw err
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
    }
  }
}
