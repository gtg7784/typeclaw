import { afterEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { renderReference } from '../references/frontmatter'
import { referencePassages } from './passages'
import { TEXT_TOKEN_BUDGET } from './truncation'

const testDirs: string[] = []

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('referencePassages', () => {
  it('chunks a long reference body into reference passages without dropping text', async () => {
    const agentDir = createAgentDir()
    const body = Array.from({ length: TEXT_TOKEN_BUDGET + 25 }, (_, i) => `word${i}`).join(' ')
    writeReference(agentDir, 'ref-a', 'Reference A', body)

    const passages = await referencePassages(agentDir)

    expect(passages.length).toBeGreaterThanOrEqual(2)
    expect(passages.map((passage) => passage.id)).toEqual(passages.map((_, i) => `reference:ref-a#${i}`))
    expect(passages.every((passage) => passage.source === 'reference')).toBe(true)
    expect(passages.map((passage) => passage.text).join('')).toBe(body)
  })
})

function createAgentDir(): string {
  const agentDir = join(tmpdir(), `typeclaw-passages-${randomUUID()}`)
  testDirs.push(agentDir)
  mkdirSync(join(agentDir, 'memory', 'references'), { recursive: true })
  return agentDir
}

function writeReference(agentDir: string, slug: string, title: string, body: string): void {
  writeFileSync(
    join(agentDir, 'memory', 'references', `${slug}.md`),
    renderReference(
      {
        title,
        origin: 'episode',
        created: '2026-06-10T00:00:00Z',
        lastAccessed: '2026-06-10T00:00:00Z',
        accessCount: 0,
        pinned: false,
        demoted: false,
        tags: [],
      },
      body,
    ),
  )
}
