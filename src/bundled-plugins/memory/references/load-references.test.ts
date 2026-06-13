import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { referenceFilePath, referencesDir } from '../paths'
import { parseReference } from './frontmatter'
import { __resetReferenceCacheForTests, bumpReferenceAccess, loadAllReferences } from './load-references'

const tmpRoots: string[] = []

beforeEach(() => {
  __resetReferenceCacheForTests()
})

afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  __resetReferenceCacheForTests()
})

describe('loadAllReferences', () => {
  test('missing references dir returns empty array', async () => {
    const agentDir = await makeAgentDir()

    await expect(loadAllReferences(agentDir)).resolves.toEqual([])
  })

  test('loads references sorted by slug with parsed bodies', async () => {
    const agentDir = await makeAgentDir()
    await writeReference(agentDir, 'zebra', 'Zebra reference', 'zebra body\n')
    await writeReference(agentDir, 'alpha', 'Alpha reference', 'alpha body\n')

    const references = await loadAllReferences(agentDir)

    expect(references.map((reference) => reference.slug)).toEqual(['alpha', 'zebra'])
    expect(references.map((reference) => reference.body)).toEqual(['alpha body\n', 'zebra body\n'])
    expect(references[0]?.path).toBe(referenceFilePath(agentDir, 'alpha'))
  })

  test('returns the cached array when file stats are unchanged', async () => {
    const agentDir = await makeAgentDir()
    await writeReference(agentDir, 'alpha', 'Alpha reference', 'alpha body\n')

    const first = await loadAllReferences(agentDir)
    const second = await loadAllReferences(agentDir)

    expect(second).toBe(first)
    expect(second[0]).toBe(first[0])
  })
})

describe('bumpReferenceAccess', () => {
  test('increments accessCount and advances lastAccessed while preserving the body', async () => {
    const agentDir = await makeAgentDir()
    await writeReference(agentDir, 'sql-query', 'SQL query', 'SELECT 1;\n')

    await bumpReferenceAccess(agentDir, ['sql-query'])

    const updated = parseReference(await readFile(referenceFilePath(agentDir, 'sql-query'), 'utf8'))
    expect(updated.frontmatter.accessCount).toBe(4)
    expect(updated.frontmatter.lastAccessed).not.toBe('2026-06-13T09:10:00+09:00')
    expect(updated.body).toBe('SELECT 1;\n')
  })

  test('skips a missing slug without throwing', async () => {
    const agentDir = await makeAgentDir()

    await expect(bumpReferenceAccess(agentDir, ['does-not-exist'])).resolves.toBeUndefined()
  })

  test('deduplicates repeated slugs so accessCount advances by one', async () => {
    const agentDir = await makeAgentDir()
    await writeReference(agentDir, 'dup', 'Dup', 'body\n')

    await bumpReferenceAccess(agentDir, ['dup', 'dup', 'dup'])

    const updated = parseReference(await readFile(referenceFilePath(agentDir, 'dup'), 'utf8'))
    expect(updated.frontmatter.accessCount).toBe(4)
  })
})

async function makeAgentDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-reference-test-'))
  tmpRoots.push(dir)
  return dir
}

async function writeReference(agentDir: string, slug: string, title: string, body: string): Promise<void> {
  await mkdir(referencesDir(agentDir), { recursive: true })
  await writeFile(referenceFilePath(agentDir, slug), referenceText(title, body), 'utf8')
}

function referenceText(title: string, body: string): string {
  return `---
title: ${title}
origin: episode
created: 2026-06-12T14:03:00+09:00
lastAccessed: 2026-06-13T09:10:00+09:00
accessCount: 3
pinned: false
demoted: false
tags: []
---
${body}`
}
