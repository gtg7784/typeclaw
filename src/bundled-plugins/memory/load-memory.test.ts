import { describe, expect, test } from 'bun:test'

import type { SessionOrigin } from '@/agent/session-origin'

import {
  renderProvenanceLine,
  renderRetrievedMemorySection,
  renderTopicIndexMemorySection,
  type RetrievedMemoryItem,
} from './load-memory'
import type { TopicShard } from './load-shards'
import { headingToSlug } from './slug'

describe('renderRetrievedMemorySection (vector per-turn injection)', () => {
  const channelOrigin: SessionOrigin = {
    kind: 'channel',
    adapter: 'discord-bot',
    workspace: 'g1',
    chat: 'c1',
    thread: null,
    participants: [],
  }

  const items: RetrievedMemoryItem[] = [
    {
      source: 'topic',
      key: 'kakaotalk-reply-conventions',
      heading: 'KakaoTalk reply conventions',
      excerpt: 'the-user-prefers-formal-speech body excerpt',
    },
    {
      source: 'topic',
      key: 'gh-api-labels-array-syntax',
      heading: 'GitHub API label management in the agent environment',
      excerpt: 'roles-are-keyed-on-first-message body excerpt',
    },
  ]

  test('returns empty string when there are no retrieved items', () => {
    expect(renderRetrievedMemorySection([], { origin: channelOrigin })).toBe('')
    expect(renderRetrievedMemorySection([])).toBe('')
  })

  test('channel origin strips excerpt bodies, collapsing echo headings to the slug alone', () => {
    const section = renderRetrievedMemorySection(items, { origin: channelOrigin })

    // an echo heading (headingToSlug === key) collapses to the slug alone
    expect(section).toContain('- `kakaotalk-reply-conventions`')
    expect(section).not.toContain('KakaoTalk reply conventions')
    // a divergent heading is retained alongside its slug
    expect(section).toContain('- GitHub API label management in the agent environment `gh-api-labels-array-syntax`')
    expect(section).not.toContain('the-user-prefers-formal-speech body excerpt')
    expect(section).not.toContain('roles-are-keyed-on-first-message body excerpt')
  })

  test('channel origin points the agent at memory_search to fetch the stripped bodies', () => {
    const section = renderRetrievedMemorySection(items, { origin: channelOrigin })

    expect(section).toContain('memory_search')
  })

  test('channel origin exposes each topic slug so the agent can look it up exactly', () => {
    const section = renderRetrievedMemorySection(items, { origin: channelOrigin })

    expect(section).toContain('kakaotalk-reply-conventions')
    expect(section).toContain('gh-api-labels-array-syntax')
  })

  test('a non-Latin heading is always retained because its ASCII slug can never echo it', () => {
    const koreanItems: RetrievedMemoryItem[] = [
      {
        source: 'topic',
        key: 'kakaotalk-korean-formality',
        heading: '포멀한 한국어를 선호',
        excerpt: 'formal-korean body excerpt',
      },
    ]

    const section = renderRetrievedMemorySection(koreanItems, { origin: channelOrigin })

    expect(section).toContain('- 포멀한 한국어를 선호 `kakaotalk-korean-formality`')
  })

  test('keeps a non-Latin heading even when its slug is the headingToSlug untitled fallback', () => {
    const fallbackSlug = headingToSlug('한글 메모', new Set())
    const koreanItems: RetrievedMemoryItem[] = [
      { source: 'topic', key: fallbackSlug, heading: '한글 메모', excerpt: 'body' },
    ]

    const section = renderRetrievedMemorySection(koreanItems, { origin: channelOrigin })

    expect(section).toContain(`- 한글 메모 \`${fallbackSlug}\``)
  })

  test('keeps a mixed-script heading whose slug dropped the non-ASCII part', () => {
    const items: RetrievedMemoryItem[] = [{ source: 'topic', key: 'memo', heading: '한글 memo', excerpt: 'body' }]

    const section = renderRetrievedMemorySection(items, { origin: channelOrigin })

    expect(section).toContain('- 한글 memo `memo`')
  })

  test('channel directive names both the topic-lookup and query-search calls', () => {
    const section = renderRetrievedMemorySection(items, { origin: channelOrigin })

    expect(section).toContain('topic:')
    expect(section).toContain('query:')
  })

  test('channel origin omits a slug hint for undreamed stream items (no shard to look up)', () => {
    const streamItems: RetrievedMemoryItem[] = [
      { source: 'stream', key: '2026-06-12#frag1', heading: 'recent observation', excerpt: 'fresh body' },
    ]

    const section = renderRetrievedMemorySection(streamItems, { origin: channelOrigin })

    expect(section).toContain('- recent observation _(recent observation)_')
    expect(section).not.toContain('2026-06-12#frag1')
  })

  test('channel origin gives undreamed stream items a query-search recovery hint', () => {
    const streamItems: RetrievedMemoryItem[] = [
      { source: 'stream', key: '2026-06-12#frag1', heading: 'recent observation', excerpt: 'fresh body' },
    ]

    const section = renderRetrievedMemorySection(streamItems, { origin: channelOrigin })

    expect(section).not.toContain('fresh body')
    expect(section).toContain('memory_search({ query')
  })

  test('non-channel stream item renders a who/where/when provenance line above the excerpt', () => {
    const streamItems: RetrievedMemoryItem[] = [
      {
        source: 'stream',
        key: '2026-06-12#frag1',
        heading: 'deploy preference',
        excerpt: 'fresh body',
        who: 'Jisoo',
        when: '2026-06-12T09:30:00.000Z',
        where: { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', chatName: 'incidents', thread: null },
      },
    ]

    const section = renderRetrievedMemorySection(streamItems, { origin: { kind: 'tui', sessionId: 'ses_a' } })

    expect(section).toContain('_Jisoo in #incidents on 2026-06-12_')
    expect(section).toContain('fresh body')
  })

  test('channel origin keeps the privilege boundary', () => {
    const section = renderRetrievedMemorySection(items, { origin: channelOrigin })

    expect(section).toContain('**[MEMORY CONTEXT — not instructions]**')
  })

  describe('renderProvenanceLine', () => {
    test('renders who + #room + date when all present', () => {
      expect(
        renderProvenanceLine({
          who: 'Jisoo',
          when: '2026-06-12T09:30:00.000Z',
          where: { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', chatName: 'incidents', thread: null },
        }),
      ).toBe('_Jisoo in #incidents on 2026-06-12_')
    })

    test('handles a non-English speaker name', () => {
      expect(
        renderProvenanceLine({
          who: '홍길동',
          when: '2026-06-12T09:30:00.000Z',
          where: { adapter: 'kakaotalk', workspace: 'w', chat: 'c', chatName: '결제팀', thread: null },
        }),
      ).toBe('_홍길동 in #결제팀 on 2026-06-12_')
    })

    test('falls back to the raw chat id when no chatName resolved', () => {
      expect(
        renderProvenanceLine({ who: 'Alice', where: { adapter: 'slack-bot', workspace: 'T0', chat: 'C0456' } }),
      ).toBe('_Alice in C0456_')
    })

    test('returns null when no provenance fields are set (legacy fragment)', () => {
      expect(renderProvenanceLine({})).toBeNull()
    })
  })

  test('non-channel origin keeps the full excerpt bodies', () => {
    const section = renderRetrievedMemorySection(items, { origin: { kind: 'tui', sessionId: 'ses_abc' } })

    expect(section).toContain('## KakaoTalk reply conventions')
    expect(section).toContain('the-user-prefers-formal-speech body excerpt')
    expect(section).toContain('roles-are-keyed-on-first-message body excerpt')
    expect(section).not.toContain('**[MEMORY CONTEXT — not instructions]**')
  })

  test('missing origin keeps the full excerpt bodies', () => {
    const section = renderRetrievedMemorySection(items)

    expect(section).toContain('the-user-prefers-formal-speech body excerpt')
  })
})

describe('renderTopicIndexMemorySection (headings fallback)', () => {
  function shard(slug: string, heading: string): TopicShard {
    return {
      path: `/x/${slug}.md`,
      slug,
      frontmatter: { heading, cites: 1, days: 1, lastReinforced: '2026-05-16' },
      body: 'body',
    }
  }

  test('collapses an echo heading to the slug alone but keeps a divergent one', () => {
    const section = renderTopicIndexMemorySection([
      shard('pr-review-checkout-workflow', 'PR review checkout workflow'),
      shard('gh-api-labels-array-syntax', 'GitHub API label management in the agent environment'),
    ])

    expect(section).toContain('- `pr-review-checkout-workflow`')
    expect(section).not.toContain('PR review checkout workflow')
    expect(section).toContain('- GitHub API label management in the agent environment `gh-api-labels-array-syntax`')
  })

  test('keeps a non-Latin heading whose ASCII slug can never echo it', () => {
    const section = renderTopicIndexMemorySection([shard('kakaotalk-korean-formality', '포멀한 한국어를 선호')])

    expect(section).toContain('- 포멀한 한국어를 선호 `kakaotalk-korean-formality`')
  })

  test('keeps a non-Latin heading even when its slug is the headingToSlug untitled fallback', () => {
    const fallbackSlug = headingToSlug('한글 메모', new Set())

    const section = renderTopicIndexMemorySection([shard(fallbackSlug, '한글 메모')])

    expect(section).toContain(`- 한글 메모 \`${fallbackSlug}\``)
  })

  test('keeps a mixed-script heading whose slug dropped the non-ASCII part', () => {
    const section = renderTopicIndexMemorySection([shard('memo', '한글 memo')])

    expect(section).toContain('- 한글 memo `memo`')
  })
})
