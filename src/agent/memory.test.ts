import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DREAMING_STATE_FILE } from '@/memory'

import { loadMemory } from './memory'

async function writeDreamingState(
  dir: string,
  dreamedThrough: Record<string, { lines: number; ts: string }>,
): Promise<void> {
  await mkdir(join(dir, 'memory'), { recursive: true })
  await writeFile(join(dir, DREAMING_STATE_FILE), JSON.stringify({ version: 1, dreamedThrough }))
}

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-memory-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

describe('loadMemory', () => {
  test('emits a # Memory header so the model knows this section exists', async () => {
    const section = await loadMemory(agentDir)

    expect(section).toContain('# Memory')
  })

  test('injects MEMORY.md content under a ## MEMORY.md header', async () => {
    // given
    await writeFile(join(agentDir, 'MEMORY.md'), 'Neo prefers terse replies.\n')

    // when
    const section = await loadMemory(agentDir)

    // then
    expect(section).toContain('## MEMORY.md')
    expect(section).toContain('Neo prefers terse replies.')
  })

  test('injects every memory/yyyy-MM-dd.md stream file under its own header', async () => {
    // given
    await mkdir(join(agentDir, 'memory'))
    await writeFile(join(agentDir, 'memory', '2026-04-26.md'), 'fragment from monday')
    await writeFile(join(agentDir, 'memory', '2026-04-27.md'), 'fragment from tuesday')

    // when
    const section = await loadMemory(agentDir)

    // then
    expect(section).toContain('## memory/2026-04-26.md')
    expect(section).toContain('fragment from monday')
    expect(section).toContain('## memory/2026-04-27.md')
    expect(section).toContain('fragment from tuesday')
  })

  test('orders stream files oldest-first so the newest day is closest to the user prompt', async () => {
    // given
    await mkdir(join(agentDir, 'memory'))
    await writeFile(join(agentDir, 'memory', '2026-04-25.md'), 'oldest')
    await writeFile(join(agentDir, 'memory', '2026-04-27.md'), 'newest')
    await writeFile(join(agentDir, 'memory', '2026-04-26.md'), 'middle')

    // when
    const section = await loadMemory(agentDir)

    // then
    const oldest = section.indexOf('## memory/2026-04-25.md')
    const middle = section.indexOf('## memory/2026-04-26.md')
    const newest = section.indexOf('## memory/2026-04-27.md')
    expect(oldest).toBeGreaterThan(-1)
    expect(oldest).toBeLessThan(middle)
    expect(middle).toBeLessThan(newest)
  })

  test('places MEMORY.md before stream files so long-term context comes first', async () => {
    // given
    await writeFile(join(agentDir, 'MEMORY.md'), 'long-term')
    await mkdir(join(agentDir, 'memory'))
    await writeFile(join(agentDir, 'memory', '2026-04-27.md'), 'stream')

    // when
    const section = await loadMemory(agentDir)

    // then
    expect(section.indexOf('## MEMORY.md')).toBeLessThan(section.indexOf('## memory/2026-04-27.md'))
  })

  test('signals [MISSING] when MEMORY.md is absent', async () => {
    // when
    const section = await loadMemory(agentDir)

    // then
    expect(section).toContain(`[MISSING] Expected at: ${join(agentDir, 'MEMORY.md')}`)
  })

  test('signals [EMPTY] when MEMORY.md exists but has no content', async () => {
    // given
    await writeFile(join(agentDir, 'MEMORY.md'), '   \n\n   ')

    // when
    const section = await loadMemory(agentDir)

    // then
    expect(section).toContain('[EMPTY]')
  })

  test('omits the stream subsection entirely when memory/ does not exist', async () => {
    // when (no memory dir)
    const section = await loadMemory(agentDir)

    // then
    expect(section).not.toContain('## memory/')
  })

  test('omits the stream subsection when memory/ is empty', async () => {
    // given
    await mkdir(join(agentDir, 'memory'))

    // when
    const section = await loadMemory(agentDir)

    // then
    expect(section).not.toContain('## memory/')
  })

  test('ignores files in memory/ that do not match yyyy-MM-dd.md', async () => {
    // given
    await mkdir(join(agentDir, 'memory'))
    await writeFile(join(agentDir, 'memory', '2026-04-27.md'), 'valid')
    await writeFile(join(agentDir, 'memory', 'README.md'), 'should be ignored')
    await writeFile(join(agentDir, 'memory', 'notes.txt'), 'should be ignored')
    await writeFile(join(agentDir, 'memory', '2026-04-27-summary.md'), 'should be ignored')

    // when
    const section = await loadMemory(agentDir)

    // then
    expect(section).toContain('## memory/2026-04-27.md')
    expect(section).not.toContain('README.md')
    expect(section).not.toContain('notes.txt')
    expect(section).not.toContain('2026-04-27-summary.md')
  })

  test('truncates a stream file larger than the per-file cap', async () => {
    // given: 20KB file, cap is 12KB
    await mkdir(join(agentDir, 'memory'))
    const huge = 'x'.repeat(20 * 1024)
    await writeFile(join(agentDir, 'memory', '2026-04-27.md'), huge)

    // when
    const section = await loadMemory(agentDir)

    // then
    expect(section).toContain('[truncated]')
    expect(section.length).toBeLessThan(huge.length)
  })

  test('truncates MEMORY.md when it exceeds the per-file cap', async () => {
    // given
    const huge = 'y'.repeat(20 * 1024)
    await writeFile(join(agentDir, 'MEMORY.md'), huge)

    // when
    const section = await loadMemory(agentDir)

    // then
    expect(section).toContain('[truncated]')
  })
})

describe('loadMemory undreamed-tail filtering', () => {
  test('omits a stream entirely when its line count equals the watermark (fully dreamed)', async () => {
    // given
    await mkdir(join(agentDir, 'memory'))
    await writeFile(join(agentDir, 'memory', '2026-04-27.md'), 'consolidated\n')
    await writeDreamingState(agentDir, { '2026-04-27': { lines: 1, ts: 'past' } })

    // when
    const section = await loadMemory(agentDir)

    // then
    expect(section).not.toContain('## memory/2026-04-27.md')
  })

  test('injects only the tail past the watermark when partially dreamed', async () => {
    // given: 5 lines total, first 2 already consolidated
    await mkdir(join(agentDir, 'memory'))
    await writeFile(
      join(agentDir, 'memory', '2026-04-27.md'),
      'old line 1\nold line 2\nnew line 3\nnew line 4\nnew line 5\n',
    )
    await writeDreamingState(agentDir, { '2026-04-27': { lines: 2, ts: 'past' } })

    // when
    const section = await loadMemory(agentDir)

    // then
    expect(section).toContain('## memory/2026-04-27.md (undreamed tail)')
    expect(section).toContain('new line 3')
    expect(section).toContain('new line 4')
    expect(section).toContain('new line 5')
    expect(section).not.toContain('old line 1')
    expect(section).not.toContain('old line 2')
  })

  test('injects the full file when no watermark is recorded for that date', async () => {
    // given: another date is watermarked, this one is not
    await mkdir(join(agentDir, 'memory'))
    await writeFile(join(agentDir, 'memory', '2026-04-26.md'), 'fully consumed\n')
    await writeFile(join(agentDir, 'memory', '2026-04-27.md'), 'untouched\n')
    await writeDreamingState(agentDir, { '2026-04-26': { lines: 1, ts: 'past' } })

    // when
    const section = await loadMemory(agentDir)

    // then
    expect(section).not.toContain('## memory/2026-04-26.md')
    expect(section).toContain('## memory/2026-04-27.md')
    expect(section).not.toContain('(undreamed tail)')
    expect(section).toContain('untouched')
  })

  test('falls back to injecting all streams when .dreaming-state.json is malformed', async () => {
    // given: state file is junk; loader should fail open
    await mkdir(join(agentDir, 'memory'))
    await writeFile(join(agentDir, 'memory', '2026-04-27.md'), 'fragment')
    await writeFile(join(agentDir, DREAMING_STATE_FILE), '{ broken')

    // when
    const section = await loadMemory(agentDir)

    // then
    expect(section).toContain('## memory/2026-04-27.md')
    expect(section).toContain('fragment')
  })

  test('treats a hand-edited stream that shrank below its watermark as fully dreamed', async () => {
    // given: file has 1 line but watermark says 99
    await mkdir(join(agentDir, 'memory'))
    await writeFile(join(agentDir, 'memory', '2026-04-27.md'), 'just one line\n')
    await writeDreamingState(agentDir, { '2026-04-27': { lines: 99, ts: 'past' } })

    // when
    const section = await loadMemory(agentDir)

    // then
    expect(section).not.toContain('## memory/2026-04-27.md')
  })
})
