import { afterEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { renderReference } from '../references/frontmatter'
import { referencePassages, topicPassage } from './passages'
import { fragmentEmbeddableText, TEXT_TOKEN_BUDGET } from './truncation'

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

describe('provenance exclusion', () => {
  it('keeps fragment embedding input byte-identical when who and origin metadata change', () => {
    const base = {
      type: 'fragment' as const,
      id: 'fragment-1',
      ts: '2026-07-01T00:00:00.000Z',
      source: 'session-1',
      entry: 'entry-1',
      topic: 'Build policy',
      body: 'Use deterministic builds.',
    }
    const enriched = {
      ...base,
      who: '홍길동',
      where: {
        adapter: 'discord',
        workspace: 'guild-1',
        workspaceName: 'Example Guild',
        chat: 'thread-1',
        chatName: '개발실',
        thread: null,
        parentChat: 'room-1',
        parentChatName: 'general',
      },
    }

    expect(fragmentEmbeddableText(enriched)).toBe(fragmentEmbeddableText(base))
    expect(fragmentEmbeddableText(enriched)).toBe('Build policy\nUse deterministic builds.')
  })

  it('keeps topic vector passage text byte-identical because citation provenance is stripped', () => {
    const first = topicPassage(
      'build-policy',
      'Build policy',
      'Use deterministic builds.\nfragments:\n- streams/2026-07-01#fragment-1',
    )
    const second = topicPassage(
      'build-policy',
      'Build policy',
      'Use deterministic builds.\nfragments:\n- streams/2026-07-02#fragment-2',
    )

    expect(second.text).toBe(first.text)
    expect(second.contentHash).toBe(first.contentHash)
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
