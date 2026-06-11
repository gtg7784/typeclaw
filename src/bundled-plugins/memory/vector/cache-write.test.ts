import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeRetrievalCache } from './cache-write'

describe('writeRetrievalCache', () => {
  let testAgentDir: string

  beforeEach(async () => {
    // Create a unique temp directory for this test
    const suffix = randomBytes(8).toString('hex')
    testAgentDir = join(tmpdir(), `typeclaw-test-cache-write-${suffix}`)
    await mkdir(testAgentDir, { recursive: true })
  })

  afterEach(async () => {
    // Clean up test directory
    try {
      await rm(testAgentDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  it('writes content to memory/.retrieval-cache/<sessionId>.md', async () => {
    // given: a session ID and content
    const sessionId = 'ses_test123'
    const content = '# Retrieved Memory\n\nSome cached content'

    // when: writing the cache
    await writeRetrievalCache(testAgentDir, sessionId, content)

    // then: the file exists at the correct path with correct content
    const cachePath = join(testAgentDir, 'memory', '.retrieval-cache', `${sessionId}.md`)
    const readContent = await readFile(cachePath, 'utf8')
    expect(readContent).toBe(content)
  })

  it('creates .retrieval-cache directory if it does not exist', async () => {
    // given: a session ID and content
    const sessionId = 'ses_test456'
    const content = 'test content'

    // when: writing the cache (directory does not exist yet)
    await writeRetrievalCache(testAgentDir, sessionId, content)

    // then: the directory was created
    const cacheDir = join(testAgentDir, 'memory', '.retrieval-cache')
    const dirStat = await stat(cacheDir)
    expect(dirStat.isDirectory()).toBe(true)
  })

  it('does not leave .tmp file after write', async () => {
    // given: a session ID and content
    const sessionId = 'ses_test789'
    const content = 'atomic write test'

    // when: writing the cache
    await writeRetrievalCache(testAgentDir, sessionId, content)

    // then: no .tmp file remains (atomic rename succeeded)
    const tmpPath = join(testAgentDir, 'memory', '.retrieval-cache', `${sessionId}.md.tmp`)
    let tmpExists = false
    try {
      await stat(tmpPath)
      tmpExists = true
    } catch {
      // Expected: file should not exist
    }
    expect(tmpExists).toBe(false)
  })

  it('overwrites existing cache file', async () => {
    // given: a session ID with existing cache
    const sessionId = 'ses_overwrite'
    const oldContent = 'old content'
    const newContent = 'new content'

    // when: writing cache twice with different content
    await writeRetrievalCache(testAgentDir, sessionId, oldContent)
    await writeRetrievalCache(testAgentDir, sessionId, newContent)

    // then: the file contains the new content
    const cachePath = join(testAgentDir, 'memory', '.retrieval-cache', `${sessionId}.md`)
    const readContent = await readFile(cachePath, 'utf8')
    expect(readContent).toBe(newContent)
  })
})
