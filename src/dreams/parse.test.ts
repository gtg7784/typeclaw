import { describe, expect, it } from 'bun:test'

import { parseDreamDetail, parseDreamSubject } from './parse'
import { DREAM_EMOJI_POOL } from './types'

describe('parseDreamSubject', () => {
  it('parses summary and trailing emoji', () => {
    const r = parseDreamSubject("dream: 3 fragments + new skill 'release-checklist' 🌙")
    expect(r.isDreamCommit).toBe(true)
    expect(r.summary).toBe("3 fragments + new skill 'release-checklist'")
    expect(r.emoji).toBe('🌙')
    expect(r.categories).toEqual(['fragments', 'skills'])
  })

  it('handles a dream commit with no emoji', () => {
    const r = parseDreamSubject('dream: 1 fragment')
    expect(r.isDreamCommit).toBe(true)
    expect(r.summary).toBe('1 fragment')
    expect(r.emoji).toBeNull()
    expect(r.categories).toEqual(['fragments'])
  })

  it('classifies watermarks-only and snapshot', () => {
    expect(parseDreamSubject('dream: watermarks only ⭐').categories).toEqual(['watermarks-only'])
    expect(parseDreamSubject('dream: snapshot 💤').categories).toEqual(['snapshot'])
  })

  it('rejects non-dream subjects', () => {
    const r = parseDreamSubject('feat(agent): add channel_react tool')
    expect(r.isDreamCommit).toBe(false)
    expect(r.summary).toBeNull()
  })

  it('every pool emoji is recognized as a trailing emoji', () => {
    for (const emoji of DREAM_EMOJI_POOL) {
      expect(parseDreamSubject(`dream: 2 fragments ${emoji}`).emoji).toBe(emoji)
    }
  })
})

describe('parseDreamDetail', () => {
  const fragment = (id: string, topic: string, body: string): string =>
    JSON.stringify({ type: 'fragment', id, ts: '2026-06-14T18:42:03.000Z', source: 'tui', entry: 'e', topic, body })

  it('extracts fragments, topic changes, created skills, and state', () => {
    const nameStatus = [
      'A\tmemory/topics/release-process.md',
      'M\tmemory/topics/commit-discipline.md',
      'A\tmemory/skills/release-checklist/SKILL.md',
      'M\tmemory/.dreaming-state.json',
    ].join('\n')

    const patch = [
      'diff --git a/memory/streams/2026-06-14.jsonl b/memory/streams/2026-06-14.jsonl',
      '--- a/memory/streams/2026-06-14.jsonl',
      '+++ b/memory/streams/2026-06-14.jsonl',
      '@@ -0,0 +1,1 @@',
      `+${fragment('019e2eca-6fc5-71ef-add9-67a0955a4b35', 'deploy', 'User always runs typecheck before commit')}`,
      'diff --git a/memory/topics/commit-discipline.md b/memory/topics/commit-discipline.md',
      '--- a/memory/topics/commit-discipline.md',
      '+++ b/memory/topics/commit-discipline.md',
      '@@ -1,1 +1,4 @@',
      '+line one',
      '+line two',
      '-old line',
    ].join('\n')

    const detail = parseDreamDetail(nameStatus, patch)

    expect(detail.addedFragments).toHaveLength(1)
    expect(detail.addedFragments[0]).toMatchObject({
      id: '019e2eca-6fc5-71ef-add9-67a0955a4b35',
      streamDate: '2026-06-14',
      topic: 'deploy',
    })
    expect(detail.createdSkills).toEqual([
      { name: 'release-checklist', path: 'memory/skills/release-checklist/SKILL.md' },
    ])
    expect(detail.stateChanged).toBe(true)

    const modified = detail.changedTopics.find((t) => t.slug === 'commit-discipline')
    expect(modified).toMatchObject({ status: 'modified', additions: 2, deletions: 1 })
    const added = detail.changedTopics.find((t) => t.slug === 'release-process')
    expect(added?.status).toBe('added')
  })

  it('ignores deleted stream lines and watermark events', () => {
    const patch = [
      'diff --git a/memory/streams/2026-06-14.jsonl b/memory/streams/2026-06-14.jsonl',
      '+++ b/memory/streams/2026-06-14.jsonl',
      '@@ -1,2 +1,1 @@',
      `-${fragment('deleted-id', 'x', 'gone')}`,
      `+${JSON.stringify({ type: 'watermark', id: 'w1', ts: '2026-06-14T00:00:00.000Z', source: 's', entry: 'e' })}`,
    ].join('\n')

    const detail = parseDreamDetail('M\tmemory/streams/2026-06-14.jsonl', patch)
    expect(detail.addedFragments).toHaveLength(0)
    expect(detail.parseWarnings).toHaveLength(0)
  })

  it('warns but keeps going on malformed JSONL', () => {
    const patch = [
      'diff --git a/memory/streams/2026-06-14.jsonl b/memory/streams/2026-06-14.jsonl',
      '+++ b/memory/streams/2026-06-14.jsonl',
      '@@ -0,0 +1,1 @@',
      '+{not valid json',
    ].join('\n')

    const detail = parseDreamDetail('M\tmemory/streams/2026-06-14.jsonl', patch)
    expect(detail.addedFragments).toHaveLength(0)
    expect(detail.parseWarnings.length).toBeGreaterThan(0)
  })

  it('classifies renames from name-status', () => {
    const detail = parseDreamDetail('R100\tmemory/topics/old.md\tmemory/topics/new.md', '')
    expect(detail.changedTopics).toEqual([
      { path: 'memory/topics/new.md', slug: 'new', status: 'renamed', additions: null, deletions: null },
    ])
  })
})
