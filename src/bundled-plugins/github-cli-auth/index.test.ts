import { afterEach, describe, expect, test } from 'bun:test'

import type { GithubTokenResolveResult } from '@/channels/github-token-bridge'
import { noopPermissionService } from '@/permissions'
import type { PluginContext, ToolBeforeEvent } from '@/plugin'

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
  test('App auth: rewrites a repo-targeting gh call with the minted token', async () => {
    process.env.GH_TOKEN = 'ghs_seeded'
    const hook = await hookFor(tokenResolver('ghs_minted'))
    const event = bashEvent('gh pr view -R acme/widgets')

    const result = await hook(event, { agentDir: '/agent', pluginName: 'github-cli-auth', logger: noopLogger })

    expect(result).toBeUndefined()
    expect(event.args.command).toBe("GH_TOKEN='ghs_minted' gh pr view -R acme/widgets")
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
    expect(resolverCalled).toBe(false)
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
