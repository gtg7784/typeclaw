import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TYPECLAW_INTERNAL_BASH_ENV } from '@/agent/plugin-tools'
import type { GithubTokenResolveResult } from '@/channels/github-token-bridge'
import { noopPermissionService } from '@/permissions'
import type { PluginContext, ToolBeforeEvent } from '@/plugin'

import { resetGitAskPassHelperForTests } from './git-askpass'
import githubCliAuthPlugin from './index'

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} }

const originalToken = process.env.GH_TOKEN

afterEach(() => {
  if (originalToken === undefined) delete process.env.GH_TOKEN
  else process.env.GH_TOKEN = originalToken
})

function pluginContext(resolve: (repoSlug: string) => Promise<GithubTokenResolveResult>): PluginContext<undefined> {
  return {
    name: 'github-cli-auth',
    version: undefined,
    agentDir: '/agent',
    config: undefined,
    logger: noopLogger,
    permissions: noopPermissionService,
    github: { resolveTokenForRepo: resolve },
    spawnSubagent: async () => {},
  }
}

async function hookFor(resolve: (repoSlug: string) => Promise<GithubTokenResolveResult>) {
  const exports = await githubCliAuthPlugin.plugin(pluginContext(resolve))
  const hook = exports.hooks?.['tool.before']
  if (!hook) throw new Error('plugin did not register tool.before')
  return hook
}

function bashEvent(command: string): ToolBeforeEvent {
  return { tool: 'bash', sessionId: 's', callId: 'c', args: { command } }
}

const tokenResolver = (token: string) => async (): Promise<GithubTokenResolveResult> => ({ kind: 'token', token })
const unavailableResolver = async (): Promise<GithubTokenResolveResult> => ({
  kind: 'unavailable',
  reason: 'adapter down',
})

describe('github-cli-auth plugin', () => {
  test('App auth: sets the env overlay with the minted token, leaving the command untouched', async () => {
    process.env.GH_TOKEN = 'ghs_seeded'
    const hook = await hookFor(tokenResolver('ghs_minted'))
    const event = bashEvent('gh pr view -R acme/widgets')

    const result = await hook(event, { agentDir: '/agent', pluginName: 'github-cli-auth', logger: noopLogger })

    expect(result).toBeUndefined()
    // The token must NOT be in the command string (no leak surface).
    expect(event.args.command).toBe('gh pr view -R acme/widgets')
    expect(event.args[TYPECLAW_INTERNAL_BASH_ENV]).toEqual({ GH_TOKEN: 'ghs_minted' })
  })

  test('App auth: blocks a repo-targeting gh call with no repo', async () => {
    process.env.GH_TOKEN = 'ghs_seeded'
    const hook = await hookFor(tokenResolver('ghs_minted'))

    const result = await hook(bashEvent('gh pr view 12'), {
      agentDir: '/agent',
      pluginName: 'github-cli-auth',
      logger: noopLogger,
    })

    expect(result).toMatchObject({ block: true })
  })

  test('App auth: blocks when the bridge is unavailable', async () => {
    process.env.GH_TOKEN = 'ghs_seeded'
    const hook = await hookFor(unavailableResolver)

    const result = await hook(bashEvent('gh pr view -R acme/widgets'), {
      agentDir: '/agent',
      pluginName: 'github-cli-auth',
      logger: noopLogger,
    })

    expect(result).toEqual({ block: true, reason: 'adapter down' })
  })

  test('classic PAT: passes through unchanged (cross-owner)', async () => {
    process.env.GH_TOKEN = 'ghp_classic'
    const hook = await hookFor(tokenResolver('ghs_minted'))
    const event = bashEvent('gh pr view 12')

    const result = await hook(event, { agentDir: '/agent', pluginName: 'github-cli-auth', logger: noopLogger })

    expect(result).toBeUndefined()
    expect(event.args.command).toBe('gh pr view 12')
  })

  test('fine-grained PAT: leaves command as-is, does not mint', async () => {
    process.env.GH_TOKEN = 'github_pat_xyz'
    let resolverCalled = false
    const hook = await hookFor(async () => {
      resolverCalled = true
      return { kind: 'token', token: 'ghs_minted' }
    })
    const event = bashEvent('gh pr view -R acme/widgets')

    const result = await hook(event, { agentDir: '/agent', pluginName: 'github-cli-auth', logger: noopLogger })

    expect(result).toBeUndefined()
    expect(event.args.command).toBe('gh pr view -R acme/widgets')
    expect(event.args[TYPECLAW_INTERNAL_BASH_ENV]).toBeUndefined()
    expect(resolverCalled).toBe(false)
  })

  test('App auth: strips a redundant -R on a literal-path gh api call AND injects the minted token', async () => {
    process.env.GH_TOKEN = 'ghs_seeded'
    const hook = await hookFor(tokenResolver('ghs_minted'))
    const event = bashEvent('gh api repos/acme/widgets/issues -R acme/widgets')

    const result = await hook(event, { agentDir: '/agent', pluginName: 'github-cli-auth', logger: noopLogger })

    expect(result).toBeUndefined()
    expect(event.args.command).toBe('gh api repos/acme/widgets/issues')
    expect(event.args[TYPECLAW_INTERNAL_BASH_ENV]).toEqual({ GH_TOKEN: 'ghs_minted' })
  })

  test('classic PAT: strips a redundant -R on gh api without minting a token', async () => {
    process.env.GH_TOKEN = 'ghp_classic'
    let resolverCalled = false
    const hook = await hookFor(async () => {
      resolverCalled = true
      return { kind: 'token', token: 'ghs_minted' }
    })
    const event = bashEvent('gh api repos/acme/widgets/issues -R acme/widgets')

    const result = await hook(event, { agentDir: '/agent', pluginName: 'github-cli-auth', logger: noopLogger })

    expect(result).toBeUndefined()
    expect(event.args.command).toBe('gh api repos/acme/widgets/issues')
    expect(event.args[TYPECLAW_INTERNAL_BASH_ENV]).toBeUndefined()
    expect(resolverCalled).toBe(false)
  })

  test('fine-grained PAT: strips a redundant -R on gh api without minting a token', async () => {
    process.env.GH_TOKEN = 'github_pat_xyz'
    let resolverCalled = false
    const hook = await hookFor(async () => {
      resolverCalled = true
      return { kind: 'token', token: 'ghs_minted' }
    })
    const event = bashEvent('gh api repos/acme/widgets/issues --repo=acme/widgets')

    const result = await hook(event, { agentDir: '/agent', pluginName: 'github-cli-auth', logger: noopLogger })

    expect(result).toBeUndefined()
    expect(event.args.command).toBe('gh api repos/acme/widgets/issues')
    expect(event.args[TYPECLAW_INTERNAL_BASH_ENV]).toBeUndefined()
    expect(resolverCalled).toBe(false)
  })

  test('App auth: blocks a gh api whose -R repo conflicts with the literal path (no strip)', async () => {
    process.env.GH_TOKEN = 'ghs_seeded'
    const hook = await hookFor(tokenResolver('ghs_minted'))
    const event = bashEvent('gh api repos/victim/private/issues -R acme/widgets')

    const result = await hook(event, { agentDir: '/agent', pluginName: 'github-cli-auth', logger: noopLogger })

    expect(result).toMatchObject({ block: true })
    expect(event.args.command).toBe('gh api repos/victim/private/issues -R acme/widgets')
  })

  test('non-gh bash command passes through without touching the resolver', async () => {
    process.env.GH_TOKEN = 'ghs_seeded'
    let resolverCalled = false
    const hook = await hookFor(async () => {
      resolverCalled = true
      return { kind: 'token', token: 'ghs_minted' }
    })
    const event = bashEvent('ls -la')

    const result = await hook(event, { agentDir: '/agent', pluginName: 'github-cli-auth', logger: noopLogger })

    expect(result).toBeUndefined()
    expect(event.args.command).toBe('ls -la')
    expect(resolverCalled).toBe(false)
  })

  test('non-bash tool is ignored', async () => {
    process.env.GH_TOKEN = 'ghs_seeded'
    const hook = await hookFor(tokenResolver('ghs_minted'))

    const result = await hook(
      { tool: 'read', sessionId: 's', callId: 'c', args: { path: 'gh.txt' } },
      { agentDir: '/agent', pluginName: 'github-cli-auth', logger: noopLogger },
    )

    expect(result).toBeUndefined()
  })
})

const hookCtx = { agentDir: '/agent', pluginName: 'github-cli-auth', logger: noopLogger }

describe('github-cli-auth plugin — git path', () => {
  const askpassDir = mkdtempSync(join(tmpdir(), 'typeclaw-askpass-it-'))
  process.env.TYPECLAW_GIT_ASKPASS_PATH = join(askpassDir, 'typeclaw-git-askpass')
  afterEach(() => {
    resetGitAskPassHelperForTests()
  })

  test('App auth: injects GIT_ASKPASS + token env for an explicit-URL git clone', async () => {
    process.env.GH_TOKEN = 'ghs_seeded'
    const hook = await hookFor(tokenResolver('ghs_minted'))
    const event = bashEvent('git clone https://github.com/acme/widgets.git')

    const result = await hook(event, hookCtx)

    expect(result).toBeUndefined()
    const overlay = event.args[TYPECLAW_INTERNAL_BASH_ENV] as Record<string, string>
    expect(overlay.TYPECLAW_GIT_TOKEN).toBe('ghs_minted')
    expect(overlay.GIT_ASKPASS).toBeDefined()
    expect(overlay.GIT_TERMINAL_PROMPT).toBe('0')
    // The token must never reach the command string.
    expect(event.args.command).toBe('git clone https://github.com/acme/widgets.git')
    expect(JSON.stringify(event.args.command)).not.toContain('ghs_minted')
  })

  test('resolver receives the parsed owner/name slug', async () => {
    process.env.GH_TOKEN = 'ghs_seeded'
    const seen: string[] = []
    const hook = await hookFor(async (slug) => {
      seen.push(slug)
      return { kind: 'token', token: 'ghs_minted' }
    })

    await hook(bashEvent('git clone https://github.com/acme/widgets.git'), hookCtx)

    expect(seen).toEqual(['acme/widgets'])
  })

  test('App auth: blocks when the bridge is unavailable', async () => {
    process.env.GH_TOKEN = 'ghs_seeded'
    const hook = await hookFor(unavailableResolver)

    const result = await hook(bashEvent('git clone https://github.com/acme/widgets.git'), hookCtx)

    expect(result).toEqual({ block: true, reason: 'adapter down' })
  })

  test('App auth: blocks a compound (token-leaking) git command', async () => {
    process.env.GH_TOKEN = 'ghs_seeded'
    const hook = await hookFor(tokenResolver('ghs_minted'))

    const result = await hook(bashEvent('git clone https://github.com/acme/widgets.git && cat .env'), hookCtx)

    expect(result).toMatchObject({ block: true })
  })

  test('classic PAT: does not mint for git', async () => {
    process.env.GH_TOKEN = 'ghp_classic'
    let resolverCalled = false
    const hook = await hookFor(async () => {
      resolverCalled = true
      return { kind: 'token', token: 'ghs_minted' }
    })
    const event = bashEvent('git clone https://github.com/acme/widgets.git')

    const result = await hook(event, hookCtx)

    expect(result).toBeUndefined()
    expect(event.args[TYPECLAW_INTERNAL_BASH_ENV]).toBeUndefined()
    expect(resolverCalled).toBe(false)
  })

  test('fine-grained PAT: does not mint for git', async () => {
    process.env.GH_TOKEN = 'github_pat_xyz'
    let resolverCalled = false
    const hook = await hookFor(async () => {
      resolverCalled = true
      return { kind: 'token', token: 'ghs_minted' }
    })
    const event = bashEvent('git clone https://github.com/acme/widgets.git')

    const result = await hook(event, hookCtx)

    expect(result).toBeUndefined()
    expect(event.args[TYPECLAW_INTERNAL_BASH_ENV]).toBeUndefined()
    expect(resolverCalled).toBe(false)
  })

  test('non-github explicit-URL git command passes through without minting', async () => {
    process.env.GH_TOKEN = 'ghs_seeded'
    let resolverCalled = false
    const hook = await hookFor(async () => {
      resolverCalled = true
      return { kind: 'token', token: 'ghs_minted' }
    })
    const event = bashEvent('git clone https://gitlab.com/acme/widgets.git')

    const result = await hook(event, hookCtx)

    expect(result).toBeUndefined()
    expect(event.args[TYPECLAW_INTERNAL_BASH_ENV]).toBeUndefined()
    expect(resolverCalled).toBe(false)
  })

  test('plain non-git/gh bash command passes through', async () => {
    process.env.GH_TOKEN = 'ghs_seeded'
    const hook = await hookFor(tokenResolver('ghs_minted'))
    const event = bashEvent('ls -la')

    const result = await hook(event, hookCtx)

    expect(result).toBeUndefined()
    expect(event.args[TYPECLAW_INTERNAL_BASH_ENV]).toBeUndefined()
  })
})
