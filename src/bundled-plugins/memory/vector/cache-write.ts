import { mkdir, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Atomically write retrieval cache to memory/.retrieval-cache/<sessionId>.md
 * using tmp+rename pattern for crash safety.
 */
export async function writeRetrievalCache(agentDir: string, sessionId: string, content: string): Promise<void> {
  const cacheDir = join(agentDir, 'memory', '.retrieval-cache')
  const cachePath = join(cacheDir, `${sessionId}.md`)
  const tmpPath = `${cachePath}.tmp`

  // Create directory if it doesn't exist
  await mkdir(cacheDir, { recursive: true })

  // Write to tmp file, then atomically rename
  await writeFile(tmpPath, content, 'utf8')
  await rename(tmpPath, cachePath)
}
