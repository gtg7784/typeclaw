import type { ContentPart, ToolResult } from '@/plugin'

import { classifyGhToken } from './token-class'

export const GRAPHQL_AUTH_NUDGE_TAG = 'github-cli-auth:graphqlRepoHint'

const NUDGE_TEXT =
  `\n\n[${GRAPHQL_AUTH_NUDGE_TAG}] That looked like a GitHub auth failure on a ` +
  '`gh api graphql` call. Under a multi-owner GitHub App there is no single ' +
  '`GH_TOKEN`, and graphql carries its repo inside the query — not an inspectable ' +
  'path — so TypeClaw cannot tell which installation token to mint. Re-run with an ' +
  'explicit repo, e.g. `gh api graphql -R owner/repo -f query=...`; TypeClaw uses ' +
  '`-R/--repo` only as the hint to inject the right token (`gh` ignores it for ' +
  'graphql routing).'

// The shell strips quotes/escapes, so we match the raw `gh ... graphql` substring
// rather than parse — the nudge is advisory, so a loose match is acceptable and a
// false positive only appends a hint to an unrelated failure.
const GRAPHQL_INVOCATION = /\bgh\b[^\n]*\bapi\b[^\n]*\bgraphql\b/

// gh / GitHub auth-failure signatures. Kept narrow so a graphql query that merely
// mentions "401" in its data does not trip the nudge: these are the strings gh and
// the API emit when the request itself was rejected for auth.
const AUTH_FAILURE_SIGNATURES = [
  'HTTP 401',
  'Bad credentials',
  'Resource not accessible by integration',
  'Resource not accessible by personal access token',
  'must be authenticated',
  'authentication required',
  'gh auth login',
  'Could not resolve to',
]

export function checkGraphqlAuthNudge(options: { tool: string; result: ToolResult }): void {
  if (options.tool !== 'bash') return

  // Only meaningful when no usable token is seeded — the multi-owner App case.
  // A seeded global token (single-owner App, classic/fine-grained PAT) means
  // graphql already authenticates, so the advice would be wrong.
  const tokenClass = classifyGhToken(process.env.GH_TOKEN)
  if (tokenClass !== 'none') return

  const text = collectText(options.result.content)
  if (!GRAPHQL_INVOCATION.test(text)) return
  if (!AUTH_FAILURE_SIGNATURES.some((sig) => text.includes(sig))) return
  if (text.includes(GRAPHQL_AUTH_NUDGE_TAG)) return

  appendAdviceToContent(options.result.content, NUDGE_TEXT)
}

function collectText(content: readonly ContentPart[]): string {
  return content
    .filter((p): p is ContentPart & { type: 'text' } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

function appendAdviceToContent(content: ContentPart[], advice: string): void {
  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i]
    if (part && part.type === 'text') {
      content[i] = { ...part, text: `${part.text}${advice}` }
      return
    }
  }
  content.push({ type: 'text', text: advice.trimStart() })
}
