import type { Option } from '@clack/prompts'

type FuzzyFilter<Value> = (search: string, option: Option<Value>) => boolean

function optionHaystack<Value>(option: Option<Value>): string {
  const label = option.label ?? String(option.value)
  const hint = option.hint ?? ''
  return `${label} ${String(option.value)} ${hint}`.toLowerCase()
}

function isSubsequence(query: string, haystack: string): boolean {
  let i = 0
  for (let j = 0; j < haystack.length && i < query.length; j++) {
    if (haystack[j] === query[i]) i++
  }
  return i === query.length
}

// Splitting the query on whitespace lets "gpt 5.5" match "GPT-5.5 Turbo": each
// token is matched independently as a subsequence, so the "-" inside "GPT-5.5"
// no longer breaks the search the way a plain substring "gpt 5.5" would. Tokens
// are order-independent so "turbo gpt" finds "GPT Turbo" too.
export function fuzzyMatch<Value>(search: string, option: Option<Value>): boolean {
  const tokens = search.toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return true
  const haystack = optionHaystack(option)
  return tokens.every((token) => isSubsequence(token, haystack))
}

export const fuzzyFilter: FuzzyFilter<unknown> = fuzzyMatch

export type { FuzzyFilter }
