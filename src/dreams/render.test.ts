import { describe, expect, it } from 'bun:test'

import { renderDetail, renderListRow, toJsonShape } from './render'
import type { DreamEntry } from './types'

const base: DreamEntry = {
  sha: 'a3f9c21f0000000000000000000000000000abcd',
  shortSha: 'a3f9c21',
  subject: "dream: 3 fragments + new skill 'release-checklist' 🌙",
  committedAt: '2026-06-14T18:42:03.000Z',
  isDreamCommit: true,
  summary: "3 fragments + new skill 'release-checklist'",
  emoji: '🌙',
  categories: ['fragments', 'skills'],
}

describe('renderListRow', () => {
  it('renders emoji, short sha, and summary without ANSI when color is off', () => {
    const row = renderListRow(base, { color: false })
    expect(row).toContain('🌙')
    expect(row).toContain('a3f9c21')
    expect(row).toContain("3 fragments + new skill 'release-checklist'")
    // eslint-disable-next-line no-control-regex
    expect(row).not.toMatch(/\u001b\[/)
  })

  it('surfaces category badges so the kind of work shows without opening the dream', () => {
    const row = renderListRow(base, { color: false })
    expect(row).toContain('[frag]')
    expect(row).toContain('[skill]')
  })

  it('shows an absolute date anchor alongside the relative time', () => {
    const row = renderListRow(base, { color: false })
    expect(row).toContain('06-14')
  })

  it('drops the noise-only "other" badge when a meaningful category exists', () => {
    const row = renderListRow({ ...base, categories: ['fragments', 'other'] }, { color: false })
    expect(row).toContain('[frag]')
    expect(row).not.toContain('[other]')
  })

  it('keeps the "other" badge when it is the only category', () => {
    const row = renderListRow({ ...base, categories: ['other'] }, { color: false })
    expect(row).toContain('[other]')
  })
})

describe('renderDetail', () => {
  it('lists fragments, topics, and skills with color off', () => {
    const entry: DreamEntry = {
      ...base,
      detail: {
        addedFragments: [{ id: 'frag-1', streamDate: '2026-06-14', topic: 'deploy', bodyPreview: 'always typecheck' }],
        changedTopics: [{ path: 'memory/topics/x.md', slug: 'x', status: 'modified', additions: 4, deletions: 1 }],
        createdSkills: [{ name: 'release-checklist', path: 'memory/skills/release-checklist/SKILL.md' }],
        stateChanged: true,
        parseWarnings: [],
      },
    }
    const out = renderDetail(entry, { color: false })
    expect(out).toContain('fragments folded in (1)')
    expect(out).toContain('deploy')
    expect(out).toContain('always typecheck')
    expect(out).toContain('+4 −1')
    expect(out).toContain('release-checklist')
    expect(out).toContain('.dreaming-state.json advanced')
  })

  it('shows a quiet-dream line when nothing was consolidated', () => {
    const entry: DreamEntry = {
      ...base,
      summary: 'watermarks only',
      detail: { addedFragments: [], changedTopics: [], createdSkills: [], stateChanged: true, parseWarnings: [] },
    }
    expect(renderDetail(entry, { color: false })).toContain('No fragments promoted')
  })
})

describe('toJsonShape', () => {
  it('omits detail when absent and includes it when present', () => {
    expect(toJsonShape(base).detail).toBeUndefined()
    const withDetail = toJsonShape({
      ...base,
      detail: { addedFragments: [], changedTopics: [], createdSkills: [], stateChanged: false, parseWarnings: [] },
    })
    expect(withDetail.detail).toBeDefined()
  })
})
