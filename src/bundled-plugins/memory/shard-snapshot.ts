import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'

export async function captureShardSnapshot(topicsDir: string): Promise<Map<string, Buffer>> {
  let entries: string[]
  try {
    entries = await readdir(topicsDir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return new Map()
    }
    throw e
  }

  const snapshot = new Map<string, Buffer>()
  for (const entry of entries) {
    if (extname(entry) !== '.md') continue
    const absPath = resolve(topicsDir, entry)
    const bytes = await readFile(absPath)
    snapshot.set(absPath, bytes)
  }

  const sorted = new Map([...snapshot.entries()].sort((a, b) => a[0].localeCompare(b[0])))
  return sorted
}

export async function restoreShardSnapshot(snapshot: Map<string, Buffer>, topicsDir: string): Promise<void> {
  for (const [absPath, bytes] of snapshot) {
    await mkdir(dirname(absPath), { recursive: true })
    await writeFile(absPath, bytes)
  }

  let currentEntries: string[]
  try {
    currentEntries = await readdir(topicsDir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw e
  }

  const snapshotKeys = new Set(snapshot.keys())
  for (const entry of currentEntries) {
    if (extname(entry) !== '.md') continue
    const absPath = resolve(topicsDir, entry)
    if (!snapshotKeys.has(absPath)) {
      await unlink(absPath)
    }
  }
}
