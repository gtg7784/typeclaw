import { describe, expect, it } from 'bun:test'

import { analyzeGhCommand } from './gh-command'

describe('analyzeGhCommand', () => {
  it('passes through commands that do not invoke gh', () => {
    expect(analyzeGhCommand('ls -la')).toEqual({ kind: 'pass-through' })
    expect(analyzeGhCommand('echo gh is great')).toEqual({ kind: 'pass-through' })
    expect(analyzeGhCommand('git push origin main')).toEqual({ kind: 'pass-through' })
  })

  it('passes through repo-less gh subcommands', () => {
    expect(analyzeGhCommand('gh auth status')).toEqual({ kind: 'pass-through' })
    expect(analyzeGhCommand('gh auth login')).toEqual({ kind: 'pass-through' })
    expect(analyzeGhCommand('gh auth token')).toEqual({ kind: 'pass-through' })
    expect(analyzeGhCommand('gh --version')).toEqual({ kind: 'pass-through' })
    expect(analyzeGhCommand('gh extension list')).toEqual({ kind: 'pass-through' })
  })

  it('passes through gh api calls without a repo path', () => {
    expect(analyzeGhCommand('gh api graphql -f query=...')).toEqual({ kind: 'pass-through' })
    expect(analyzeGhCommand('gh api /user')).toEqual({ kind: 'pass-through' })
    expect(analyzeGhCommand('gh api /rate_limit')).toEqual({ kind: 'pass-through' })
  })

  it('extracts the repo from -R owner/repo', () => {
    expect(analyzeGhCommand('gh pr view -R acme/widgets')).toEqual({
      kind: 'inject',
      repoSlug: 'acme/widgets',
    })
  })

  it('extracts the repo from --repo owner/repo', () => {
    expect(analyzeGhCommand('gh issue list --repo acme/widgets')).toEqual({
      kind: 'inject',
      repoSlug: 'acme/widgets',
    })
  })

  it('extracts the repo from --repo=owner/repo', () => {
    expect(analyzeGhCommand('gh release view --repo=acme/widgets')).toEqual({
      kind: 'inject',
      repoSlug: 'acme/widgets',
    })
  })

  it('extracts the repo from a gh api /repos/{owner}/{repo} path', () => {
    expect(analyzeGhCommand('gh api /repos/acme/widgets/pulls/12/reviews -f event=APPROVE')).toEqual({
      kind: 'inject',
      repoSlug: 'acme/widgets',
    })
  })

  it('extracts the repo from a gh api repos/{owner}/{repo} path without leading slash', () => {
    expect(analyzeGhCommand('gh api repos/acme/widgets/issues')).toEqual({
      kind: 'inject',
      repoSlug: 'acme/widgets',
    })
  })

  it('blocks a repo-targeting subcommand with no repo specified', () => {
    const result = analyzeGhCommand('gh pr view 12')
    expect(result.kind).toBe('block')
    if (result.kind === 'block') expect(result.reason).toContain('-R')
  })

  it('blocks gh pr create without a repo', () => {
    expect(analyzeGhCommand('gh pr create --title x --body y').kind).toBe('block')
  })

  it('detects gh after a leading environment assignment', () => {
    expect(analyzeGhCommand('FOO=bar gh pr view -R acme/widgets')).toEqual({
      kind: 'inject',
      repoSlug: 'acme/widgets',
    })
  })
})
