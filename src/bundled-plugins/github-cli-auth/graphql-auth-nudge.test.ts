import { afterEach, describe, expect, test } from 'bun:test'

import type { ContentPart, ToolResult } from '@/plugin'

import { checkGraphqlAuthNudge, GRAPHQL_AUTH_NUDGE_TAG } from './graphql-auth-nudge'

const originalToken = process.env.GH_TOKEN

afterEach(() => {
  if (originalToken === undefined) delete process.env.GH_TOKEN
  else process.env.GH_TOKEN = originalToken
})

function bashResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}

function textOf(result: ToolResult): string {
  return result.content
    .filter((p): p is ContentPart & { type: 'text' } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

describe('checkGraphqlAuthNudge', () => {
  test('appends the repo hint when a gh api graphql call fails auth with no seeded token', () => {
    delete process.env.GH_TOKEN
    const result = bashResult('gh api graphql -f query=... \nHTTP 401: Bad credentials')

    checkGraphqlAuthNudge({ tool: 'bash', result })

    expect(textOf(result)).toContain(GRAPHQL_AUTH_NUDGE_TAG)
    expect(textOf(result)).toContain('-R owner/repo')
  })

  test('matches the "Resource not accessible by integration" App-auth signature', () => {
    delete process.env.GH_TOKEN
    const result = bashResult('gh api graphql -f query=...\ngh: Resource not accessible by integration')

    checkGraphqlAuthNudge({ tool: 'bash', result })

    expect(textOf(result)).toContain(GRAPHQL_AUTH_NUDGE_TAG)
  })

  test('does not fire when a token is seeded (graphql already authenticates)', () => {
    process.env.GH_TOKEN = 'ghs_seeded'
    const result = bashResult('gh api graphql -f query=...\nHTTP 401: Bad credentials')

    checkGraphqlAuthNudge({ tool: 'bash', result })

    expect(textOf(result)).not.toContain(GRAPHQL_AUTH_NUDGE_TAG)
  })

  test('does not fire on a graphql call that succeeded (no auth-failure signature)', () => {
    delete process.env.GH_TOKEN
    const result = bashResult('gh api graphql -f query=...\n{"data":{"repository":{"id":"R_x"}}}')

    checkGraphqlAuthNudge({ tool: 'bash', result })

    expect(textOf(result)).not.toContain(GRAPHQL_AUTH_NUDGE_TAG)
  })

  test('does not fire on a non-graphql auth failure (REST path handled by tool.before)', () => {
    delete process.env.GH_TOKEN
    const result = bashResult('gh api /repos/acme/widgets/pulls\nHTTP 401: Bad credentials')

    checkGraphqlAuthNudge({ tool: 'bash', result })

    expect(textOf(result)).not.toContain(GRAPHQL_AUTH_NUDGE_TAG)
  })

  test('does not double-append when the hint is already present', () => {
    delete process.env.GH_TOKEN
    const result = bashResult('gh api graphql -f query=...\nHTTP 401')
    checkGraphqlAuthNudge({ tool: 'bash', result })
    const once = textOf(result)

    checkGraphqlAuthNudge({ tool: 'bash', result })

    expect(textOf(result)).toBe(once)
  })

  test('ignores non-bash tools', () => {
    delete process.env.GH_TOKEN
    const result = bashResult('gh api graphql\nHTTP 401: Bad credentials')

    checkGraphqlAuthNudge({ tool: 'read', result })

    expect(textOf(result)).not.toContain(GRAPHQL_AUTH_NUDGE_TAG)
  })
})
