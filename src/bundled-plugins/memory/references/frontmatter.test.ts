import { describe, expect, test } from 'bun:test'

import { parseReference, renderReference } from './frontmatter'

describe('reference frontmatter', () => {
  test('parse and render round-trips a fully-specified reference byte-identically', () => {
    const text = `---
title: Debugging transcript
origin: episode
created: 2026-06-12T14:03:00+09:00
lastAccessed: 2026-06-13T09:10:00+09:00
accessCount: 3
pinned: false
demoted: false
tags: [debugging, transcript]
---
Verbatim body.
`

    const { frontmatter, body } = parseReference(text)

    expect(renderReference(frontmatter, body)).toBe(text)
  })

  test('runtime-owned fields default when only author-owned fields are present', () => {
    const text = `---
title: Deployment checklist
origin: curated
created: 2026-06-12T14:03:00+09:00
pinned: true
tags: []
---
Keep this exact text.
`

    const { frontmatter, body } = parseReference(text)

    expect(frontmatter).toEqual({
      title: 'Deployment checklist',
      origin: 'curated',
      created: '2026-06-12T14:03:00+09:00',
      lastAccessed: '2026-06-12T14:03:00+09:00',
      accessCount: 0,
      pinned: true,
      demoted: false,
      tags: [],
    })
    expect(body).toBe('Keep this exact text.\n')
  })
})
