import { describe, expect, test } from 'bun:test'

import { analyzeGitCommand, type GitResolvers, parseGithubRepoFromGitUrl } from './git-command'

const CWD = '/agent'

function resolvers(overrides: Partial<GitResolvers> = {}): GitResolvers {
  return {
    resolveRemoteUrl: async () => null,
    resolveConfig: async () => null,
    resolveCurrentBranch: async () => null,
    ...overrides,
  }
}

async function analyze(command: string, r: GitResolvers = resolvers()) {
  return analyzeGitCommand(command, { cwd: CWD, resolvers: r })
}

describe('parseGithubRepoFromGitUrl', () => {
  test('parses https url', () => {
    expect(parseGithubRepoFromGitUrl('https://github.com/acme/widgets')).toBe('acme/widgets')
  })
  test('parses https url with .git suffix', () => {
    expect(parseGithubRepoFromGitUrl('https://github.com/acme/widgets.git')).toBe('acme/widgets')
  })
  test('parses scp-like url', () => {
    expect(parseGithubRepoFromGitUrl('git@github.com:acme/widgets.git')).toBe('acme/widgets')
  })
  test('parses ssh url', () => {
    expect(parseGithubRepoFromGitUrl('ssh://git@github.com/acme/widgets.git')).toBe('acme/widgets')
  })
  test('rejects non-github host', () => {
    expect(parseGithubRepoFromGitUrl('https://gitlab.com/acme/widgets')).toBeNull()
  })
  test('rejects credential-bearing https url', () => {
    expect(parseGithubRepoFromGitUrl('https://tok@github.com/acme/widgets')).toBeNull()
  })
  test('rejects local and relative paths', () => {
    expect(parseGithubRepoFromGitUrl('/srv/repos/widgets.git')).toBeNull()
    expect(parseGithubRepoFromGitUrl('../widgets')).toBeNull()
  })
  test('rejects missing owner or name', () => {
    expect(parseGithubRepoFromGitUrl('https://github.com/acme')).toBeNull()
  })
})

describe('analyzeGitCommand — pass-through', () => {
  test('non-git command', async () => {
    expect(await analyze('ls -la')).toEqual({ kind: 'pass-through' })
  })
  test('non-remote git subcommand (status)', async () => {
    expect(await analyze('git status')).toEqual({ kind: 'pass-through' })
  })
  test('read-only git remote -v', async () => {
    expect(await analyze('git remote -v')).toEqual({ kind: 'pass-through' })
  })
  test('remote resolver fails (no configured remote)', async () => {
    expect(await analyze('git push origin main')).toEqual({ kind: 'pass-through' })
  })
  test('non-github remote url', async () => {
    const r = resolvers({ resolveRemoteUrl: async () => 'https://gitlab.com/acme/widgets.git' })
    expect(await analyze('git push origin main', r)).toEqual({ kind: 'pass-through' })
  })
  test('explicit non-github clone url', async () => {
    expect(await analyze('git clone https://gitlab.com/acme/widgets.git')).toEqual({ kind: 'pass-through' })
  })
})

describe('analyzeGitCommand — inject (explicit url)', () => {
  test('clone https', async () => {
    expect(await analyze('git clone https://github.com/acme/widgets.git')).toEqual({
      kind: 'inject',
      repoSlug: 'acme/widgets',
    })
  })
  test('ls-remote scp-like', async () => {
    expect(await analyze('git ls-remote git@github.com:acme/widgets.git')).toEqual({
      kind: 'inject',
      repoSlug: 'acme/widgets',
    })
  })
  test('push --repo url', async () => {
    expect(await analyze('git push --repo https://github.com/acme/widgets.git main')).toEqual({
      kind: 'inject',
      repoSlug: 'acme/widgets',
    })
  })
})

describe('analyzeGitCommand — inject (remote resolution)', () => {
  const ghRemote = resolvers({ resolveRemoteUrl: async () => 'https://github.com/acme/widgets.git' })

  test('fetch origin', async () => {
    expect(await analyze('git fetch origin', ghRemote)).toEqual({ kind: 'inject', repoSlug: 'acme/widgets' })
  })
  test('pull origin main', async () => {
    expect(await analyze('git pull origin main', ghRemote)).toEqual({ kind: 'inject', repoSlug: 'acme/widgets' })
  })
  test('push origin main', async () => {
    expect(await analyze('git push origin main', ghRemote)).toEqual({ kind: 'inject', repoSlug: 'acme/widgets' })
  })
  test('push -u origin branch (value flag skipped)', async () => {
    expect(await analyze('git push -u origin feature', ghRemote)).toEqual({ kind: 'inject', repoSlug: 'acme/widgets' })
  })
})

describe('analyzeGitCommand — bare push remote resolution chain', () => {
  test('uses branch.<cur>.pushRemote first', async () => {
    const r = resolvers({
      resolveCurrentBranch: async () => 'feature',
      resolveConfig: async (_cwd, key) => (key === 'branch.feature.pushRemote' ? 'upstream' : null),
      resolveRemoteUrl: async (_cwd, remote) => (remote === 'upstream' ? 'https://github.com/acme/widgets.git' : null),
    })
    expect(await analyze('git push', r)).toEqual({ kind: 'inject', repoSlug: 'acme/widgets' })
  })
  test('falls back to remote.pushDefault', async () => {
    const r = resolvers({
      resolveCurrentBranch: async () => 'feature',
      resolveConfig: async (_cwd, key) => (key === 'remote.pushDefault' ? 'origin2' : null),
      resolveRemoteUrl: async (_cwd, remote) => (remote === 'origin2' ? 'git@github.com:acme/widgets.git' : null),
    })
    expect(await analyze('git push', r)).toEqual({ kind: 'inject', repoSlug: 'acme/widgets' })
  })
  test('falls back to origin', async () => {
    const r = resolvers({
      resolveCurrentBranch: async () => 'main',
      resolveRemoteUrl: async (_cwd, remote) => (remote === 'origin' ? 'https://github.com/acme/widgets.git' : null),
    })
    expect(await analyze('git push', r)).toEqual({ kind: 'inject', repoSlug: 'acme/widgets' })
  })
})

describe('analyzeGitCommand — blocks', () => {
  test('compound command (&&) blocks', async () => {
    const r = resolvers({ resolveRemoteUrl: async () => 'https://github.com/acme/widgets.git' })
    expect((await analyze('git push origin main && echo done', r)).kind).toBe('block')
  })
  test('token-bearing command with pipe blocks', async () => {
    const r = resolvers({ resolveRemoteUrl: async () => 'https://github.com/acme/widgets.git' })
    expect((await analyze('git push origin main | tee log', r)).kind).toBe('block')
  })
  test('token-bearing command with command substitution blocks', async () => {
    expect((await analyze('git clone https://github.com/acme/widgets.git $(whoami)')).kind).toBe('block')
  })
  test('token-bearing command with semicolon blocks', async () => {
    expect((await analyze('git clone https://github.com/acme/widgets.git; ls')).kind).toBe('block')
  })
})

describe('analyzeGitCommand — cd rewrite', () => {
  const ghRemote = resolvers({ resolveRemoteUrl: async () => 'https://github.com/acme/widgets.git' })

  test('cd repo && git push is rewritten to git -C', async () => {
    const result = await analyze('cd workspace/repo && git push origin main', ghRemote)
    expect(result).toEqual({
      kind: 'inject',
      repoSlug: 'acme/widgets',
      rewrittenCommand: "git -C '/agent/workspace/repo' push origin main",
    })
  })
  test('cd with absolute path', async () => {
    const result = await analyze('cd /agent/workspace/repo && git push', ghRemote)
    expect(result).toMatchObject({ kind: 'inject', rewrittenCommand: "git -C '/agent/workspace/repo' push" })
  })
  test('unsafe cd with variable is not treated as safe prefix and blocks', async () => {
    expect((await analyze('cd "$DIR" && git push origin main', ghRemote)).kind).toBe('block')
  })
})

describe('analyzeGitCommand — git -C resolution', () => {
  test('respects existing git -C for remote resolution', async () => {
    const seen: string[] = []
    const r = resolvers({
      resolveRemoteUrl: async (cwd) => {
        seen.push(cwd)
        return 'https://github.com/acme/widgets.git'
      },
    })
    const result = await analyze('git -C workspace/repo push origin main', r)
    expect(result).toEqual({ kind: 'inject', repoSlug: 'acme/widgets' })
    expect(seen).toContain('/agent/workspace/repo')
  })
})

describe('analyzeGitCommand — config value flag is not mistaken for subcommand', () => {
  test('git -c key=value push', async () => {
    const r = resolvers({ resolveRemoteUrl: async () => 'https://github.com/acme/widgets.git' })
    expect(await analyze('git -c credential.helper= push origin main', r)).toEqual({
      kind: 'inject',
      repoSlug: 'acme/widgets',
    })
  })
})
