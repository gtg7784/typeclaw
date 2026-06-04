import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_GITHUB_EVENT_ALLOWLIST } from '@/channels/schema'

import {
  buildConfigMigrationCommitMessage,
  configSchema,
  extractPluginConfigs,
  expandMountPath,
  loadConfigSync,
  loadConfigSyncOrDefaults,
  loadPluginConfigsSync,
  migrateLegacyConfigShape,
  mcpServerSchema,
  mountSchema,
  resolveProfile,
  validateConfig,
  validateMount,
  type Models,
} from './config'

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

const VALID_MODEL = 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo'
const VALID_MODEL_2 = 'openai/gpt-5.4-nano'

describe('configSchema models field', () => {
  test('defaults to { default: [<DEFAULT_MODEL_REF>] } when omitted', () => {
    const parsed = configSchema.parse({})
    expect(parsed.models).toEqual({ default: ['openai/gpt-5.4-nano'] })
  })

  test('normalises a single-ref string input to a one-element array', () => {
    const parsed = configSchema.parse({ models: { default: VALID_MODEL } })
    expect(parsed.models).toEqual({ default: [VALID_MODEL] })
  })

  test('accepts multiple profiles in either shape and normalises both', () => {
    const parsed = configSchema.parse({
      models: { default: VALID_MODEL, fast: [VALID_MODEL_2], deep: VALID_MODEL, vision: VALID_MODEL_2 },
    })
    expect(parsed.models.default).toEqual([VALID_MODEL])
    expect(parsed.models.fast).toEqual([VALID_MODEL_2])
    expect(parsed.models.deep).toEqual([VALID_MODEL])
    expect(parsed.models.vision).toEqual([VALID_MODEL_2])
  })

  test('accepts a fallback chain as an array', () => {
    const parsed = configSchema.parse({
      models: { default: [VALID_MODEL, VALID_MODEL_2] },
    })
    expect(parsed.models.default).toEqual([VALID_MODEL, VALID_MODEL_2])
  })

  test('accepts user-defined profile names alongside well-known ones', () => {
    const parsed = configSchema.parse({
      models: { default: VALID_MODEL, 'cheap-batch': VALID_MODEL_2 },
    })
    expect(parsed.models['cheap-batch']).toEqual([VALID_MODEL_2])
  })

  test('rejects models map without default', () => {
    expect(() => configSchema.parse({ models: { fast: VALID_MODEL } })).toThrow()
  })

  test('rejects unknown model refs (string shape)', () => {
    expect(() => configSchema.parse({ models: { default: 'not-a-real-model' } })).toThrow()
  })

  test('rejects unknown model refs inside a chain', () => {
    expect(() => configSchema.parse({ models: { default: [VALID_MODEL, 'not-a-real-model'] } })).toThrow()
  })

  test('rejects empty arrays', () => {
    expect(() => configSchema.parse({ models: { default: [] } })).toThrow()
  })

  test('rejects empty profile names', () => {
    expect(() => configSchema.parse({ models: { '': VALID_MODEL } })).toThrow()
  })

  test('rejects exact duplicate refs in a chain (config typo)', () => {
    expect(() => configSchema.parse({ models: { default: [VALID_MODEL, VALID_MODEL] } })).toThrow(/duplicate/i)
  })

  test('accepts different models from the same provider in a chain', () => {
    const parsed = configSchema.parse({
      models: { default: ['openai/gpt-5.4-nano', 'openai/gpt-5.4-mini'] },
    })
    expect(parsed.models.default).toEqual(['openai/gpt-5.4-nano', 'openai/gpt-5.4-mini'])
  })
})

describe('resolveProfile', () => {
  const models: Models = { default: [VALID_MODEL], fast: [VALID_MODEL_2] }

  test('returns the requested profile when present', () => {
    const result = resolveProfile(models, 'fast')
    expect(result.ref).toBe(VALID_MODEL_2)
    expect(result.refs).toEqual([VALID_MODEL_2])
    expect(result.profile).toBe('fast')
    expect(result.fellBackToDefault).toBe(false)
  })

  test('returns default when name is undefined', () => {
    const result = resolveProfile(models, undefined)
    expect(result.ref).toBe(VALID_MODEL)
    expect(result.refs).toEqual([VALID_MODEL])
    expect(result.profile).toBe('default')
    expect(result.fellBackToDefault).toBe(false)
  })

  test('returns default when name is "default"', () => {
    const result = resolveProfile(models, 'default')
    expect(result.ref).toBe(VALID_MODEL)
    expect(result.refs).toEqual([VALID_MODEL])
    expect(result.profile).toBe('default')
    expect(result.fellBackToDefault).toBe(false)
  })

  test('falls back to default when requested profile is missing, flagging the fallback', () => {
    const result = resolveProfile(models, 'deep')
    expect(result.ref).toBe(VALID_MODEL)
    expect(result.refs).toEqual([VALID_MODEL])
    expect(result.profile).toBe('default')
    expect(result.fellBackToDefault).toBe(true)
  })

  test('exposes the full chain when the profile is a multi-ref fallback', () => {
    const chain: Models = { default: [VALID_MODEL, VALID_MODEL_2] }
    const result = resolveProfile(chain, 'default')
    expect(result.ref).toBe(VALID_MODEL)
    expect(result.refs).toEqual([VALID_MODEL, VALID_MODEL_2])
  })

  test('inherits the default chain when falling back, preserving every fallback ref', () => {
    const chain: Models = { default: [VALID_MODEL, VALID_MODEL_2] }
    const result = resolveProfile(chain, 'deep')
    expect(result.refs).toEqual([VALID_MODEL, VALID_MODEL_2])
    expect(result.fellBackToDefault).toBe(true)
  })
})

describe('configSchema', () => {
  test('defaults mounts to [] when omitted (predating the field is fine)', () => {
    const parsed = configSchema.parse({ models: { default: VALID_MODEL } })
    expect(parsed.mounts).toEqual([])
  })

  test('accepts config with empty mounts array', () => {
    const parsed = configSchema.parse({ models: { default: VALID_MODEL }, mounts: [] })
    expect(parsed.mounts).toEqual([])
  })

  test('accepts config with one mount, defaulting readOnly to false', () => {
    const parsed = configSchema.parse({
      models: { default: VALID_MODEL },
      mounts: [{ name: 'projects', path: '~/projects' }],
    })
    expect(parsed.mounts).toEqual([{ name: 'projects', path: '~/projects', readOnly: false }])
  })

  test('preserves readOnly: true when provided', () => {
    const parsed = configSchema.parse({
      models: { default: VALID_MODEL },
      mounts: [{ name: 'notes', path: '~/notes', readOnly: true }],
    })
    expect(parsed.mounts[0]?.readOnly).toBe(true)
  })

  test('preserves description when provided', () => {
    const parsed = configSchema.parse({
      models: { default: VALID_MODEL },
      mounts: [{ name: 'src', path: '~/src', description: 'monorepo' }],
    })
    expect(parsed.mounts[0]?.description).toBe('monorepo')
  })
})

describe('mcpServerSchema', () => {
  test('accepts a stdio server config', () => {
    const parsed = mcpServerSchema.parse({
      name: 'filesystem',
      command: 'bunx',
      args: ['@modelcontextprotocol/server-filesystem'],
    })
    expect(parsed).toEqual({
      name: 'filesystem',
      enabled: true,
      command: 'bunx',
      args: ['@modelcontextprotocol/server-filesystem'],
      env: {},
    })
  })

  test('accepts an http server config', () => {
    const parsed = mcpServerSchema.parse({ name: 'remote-docs', url: 'https://mcp.example.com/mcp' })
    expect(parsed).toEqual({
      name: 'remote-docs',
      enabled: true,
      args: [],
      url: 'https://mcp.example.com/mcp',
      env: {},
    })
  })

  test('defaults enabled to true when omitted', () => {
    const parsed = mcpServerSchema.parse({ name: 'default-on', command: 'server' })

    expect(parsed.enabled).toBe(true)
  })

  test('preserves enabled: false', () => {
    const parsed = mcpServerSchema.parse({ name: 'disabled', enabled: false, command: 'server' })

    expect(parsed.enabled).toBe(false)
  })

  test('preserves explicit enabled: true', () => {
    const parsed = mcpServerSchema.parse({ name: 'explicitly-on', enabled: true, command: 'server' })

    expect(parsed.enabled).toBe(true)
  })

  test('preserves explicit request timeout', () => {
    const parsed = mcpServerSchema.parse({ name: 'with-timeout', timeoutMs: 1234, command: 'server' })

    expect(parsed.timeoutMs).toBe(1234)
  })

  test('rejects a server with both command and url', () => {
    expect(() =>
      mcpServerSchema.parse({ name: 'mixed', command: 'server', url: 'https://mcp.example.com/mcp' }),
    ).toThrow(/either stdio \(command\) or http \(url\)/)
  })

  test('rejects a server with neither command nor url', () => {
    expect(() => mcpServerSchema.parse({ name: 'missing-transport' })).toThrow(
      /either stdio \(command\) or http \(url\)/,
    )
  })

  test('normalises env string shorthand and env-object secrets', () => {
    const parsed = mcpServerSchema.parse({
      name: 'with-env',
      command: 'server',
      env: {
        INLINE_TOKEN: 'test-token',
        API_KEY: { env: 'MCP_API_KEY' },
      },
    })

    expect(parsed.env).toEqual({
      INLINE_TOKEN: { value: 'test-token' },
      API_KEY: { env: 'MCP_API_KEY' },
    })
  })

  test('rejects names outside the mount namespace pattern', () => {
    expect(() => mcpServerSchema.parse({ name: 'BadName', command: 'server' })).toThrow(/MCP server name/)
    expect(() => mcpServerSchema.parse({ name: '-bad', command: 'server' })).toThrow(/MCP server name/)
  })

  test('rejects double underscore names because the sequence separates MCP tool namespaces', () => {
    expect(() => mcpServerSchema.parse({ name: 'bad__server', command: 'server' })).toThrow(/must not contain '__'/)
  })

  test('allows single underscores in server names', () => {
    expect(() => mcpServerSchema.parse({ name: 'good_server', command: 'server' })).not.toThrow()
  })

  test('rejects a url that is not http(s)', () => {
    expect(() => mcpServerSchema.parse({ name: 'ftp-server', url: 'ftp://mcp.example.com/mcp' })).toThrow(
      /http:\/\/ or https:\/\//,
    )
  })

  test('accepts a plain http url', () => {
    expect(() => mcpServerSchema.parse({ name: 'local-http', url: 'http://localhost:8080/mcp' })).not.toThrow()
  })

  test('accepts http(s) urls regardless of scheme casing', () => {
    expect(() => mcpServerSchema.parse({ name: 'upper-https', url: 'HTTPS://mcp.example.com/mcp' })).not.toThrow()
    expect(() => mcpServerSchema.parse({ name: 'upper-http', url: 'HTTP://localhost:8080/mcp' })).not.toThrow()
  })

  test('rejects env keys that are not valid identifiers', () => {
    expect(() => mcpServerSchema.parse({ name: 'bad-env', command: 'server', env: { 'API KEY': 'x' } })).toThrow(
      /valid identifier/,
    )
    expect(() => mcpServerSchema.parse({ name: 'bad-env2', command: 'server', env: { '1LEADING': 'x' } })).toThrow(
      /valid identifier/,
    )
  })

  test('rejects a whitespace-only command', () => {
    expect(() => mcpServerSchema.parse({ name: 'blank-cmd', command: '   ' })).toThrow()
  })

  test('rejects a timeout above the 10-minute ceiling', () => {
    expect(() => mcpServerSchema.parse({ name: 'slow', command: 'server', timeoutMs: 600_001 })).toThrow()
    expect(() => mcpServerSchema.parse({ name: 'ok-slow', command: 'server', timeoutMs: 600_000 })).not.toThrow()
  })

  test('preserves an optional description for the later MCP catalog', () => {
    const parsed = mcpServerSchema.parse({
      name: 'github',
      description: 'GitHub issues, PRs, and code search',
      command: 'server',
    })

    expect(parsed.description).toBe('GitHub issues, PRs, and code search')
  })
})

describe('configSchema mcpServers field', () => {
  test('defaults to [] when omitted', () => {
    const parsed = configSchema.parse({ models: { default: VALID_MODEL } })
    expect(parsed.mcpServers).toEqual([])
  })

  test('accepts stdio and http server declarations', () => {
    const parsed = configSchema.parse({
      models: { default: VALID_MODEL },
      mcpServers: [
        { name: 'filesystem', command: 'bunx', args: ['@modelcontextprotocol/server-filesystem'] },
        { name: 'remote-docs', url: 'https://mcp.example.com/mcp' },
      ],
    })

    expect(parsed.mcpServers).toEqual([
      {
        name: 'filesystem',
        enabled: true,
        command: 'bunx',
        args: ['@modelcontextprotocol/server-filesystem'],
        env: {},
      },
      { name: 'remote-docs', enabled: true, args: [], url: 'https://mcp.example.com/mcp', env: {} },
    ])
  })

  test('rejects duplicate server names with an indexed path at the offending entry', () => {
    const result = configSchema.safeParse({
      models: { default: VALID_MODEL },
      mcpServers: [
        { name: 'github', command: 'server' },
        { name: 'github', url: 'https://mcp.example.com/mcp' },
      ],
    })

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected duplicate names to be rejected')
    const issue = result.error.issues.find((i) => i.message.includes('duplicates'))
    expect(issue?.path).toEqual(['mcpServers', 1, 'name'])
  })
})

describe('configSchema alias field', () => {
  test('defaults to [] when omitted', () => {
    const parsed = configSchema.parse({ models: { default: VALID_MODEL } })
    expect(parsed.alias).toEqual([])
  })

  test('accepts a non-empty alias array', () => {
    const parsed = configSchema.parse({ models: { default: VALID_MODEL }, alias: ['bongbong', '봉봉'] })
    expect(parsed.alias).toEqual(['bongbong', '봉봉'])
  })

  test('trims surrounding whitespace from each entry', () => {
    const parsed = configSchema.parse({ models: { default: VALID_MODEL }, alias: ['  bongbong  ', '\t봉봉\n'] })
    expect(parsed.alias).toEqual(['bongbong', '봉봉'])
  })

  test('rejects empty-string entries', () => {
    expect(() => configSchema.parse({ models: { default: VALID_MODEL }, alias: [''] })).toThrow()
  })

  test('rejects whitespace-only entries (would otherwise match every message after trim)', () => {
    expect(() => configSchema.parse({ models: { default: VALID_MODEL }, alias: ['   '] })).toThrow()
  })
})

describe('configSchema preserves unknown top-level keys (plugin config blocks)', () => {
  test('a top-level "memory" block survives the schema as unknown (consumed by the bundled memory plugin)', () => {
    const parsed = configSchema.parse({
      models: { default: VALID_MODEL },
      memory: { idleMs: 60_000, dreaming: { schedule: '30 3 * * *' } },
    })
    expect(parsed['memory']).toEqual({ idleMs: 60_000, dreaming: { schedule: '30 3 * * *' } })
  })

  test('agentBrowser is treated as plugin/user config instead of a core key', () => {
    const configs = extractPluginConfigs({
      models: { default: VALID_MODEL },
      agentBrowser: { dashboardProxy: false },
      customPlugin: { enabled: true },
    })

    expect(configs).toEqual({ agentBrowser: { dashboardProxy: false }, customPlugin: { enabled: true } })
  })

  test('treats mcpServers and tunnels as known top-level keys, not plugin blocks', () => {
    const configs = extractPluginConfigs({
      models: { default: VALID_MODEL },
      mcpServers: [{ name: 'fs', command: 'server' }],
      tunnels: [{ provider: 'cloudflare-quick' }],
      customPlugin: { enabled: true },
    })

    expect(configs).toEqual({ customPlugin: { enabled: true } })
  })
})

describe('portForwardSchema', () => {
  test('defaults to allow:* when omitted', () => {
    const parsed = configSchema.parse({ models: { default: VALID_MODEL } })
    expect(parsed.portForward).toEqual({ allow: '*' })
  })

  test('accepts allow:* with no deny', () => {
    const parsed = configSchema.parse({ models: { default: VALID_MODEL }, portForward: { allow: '*' } })
    expect(parsed.portForward).toEqual({ allow: '*' })
  })

  test('accepts allow:* with deny list', () => {
    const parsed = configSchema.parse({
      models: { default: VALID_MODEL },
      portForward: { allow: '*', deny: [9229, 9999] },
    })
    expect(parsed.portForward).toEqual({ allow: '*', deny: [9229, 9999] })
  })

  test('accepts allow as number array (allowlist mode)', () => {
    const parsed = configSchema.parse({ models: { default: VALID_MODEL }, portForward: { allow: [3000, 5173] } })
    expect(parsed.portForward).toEqual({ allow: [3000, 5173] })
  })

  test('accepts allow:[] as off-switch', () => {
    const parsed = configSchema.parse({ models: { default: VALID_MODEL }, portForward: { allow: [] } })
    expect(parsed.portForward).toEqual({ allow: [] })
  })

  test('rejects deny combined with allow:number[] so user typos do not silently drop the deny rule', () => {
    expect(() =>
      configSchema.parse({ models: { default: VALID_MODEL }, portForward: { allow: [3000], deny: [9000] } }),
    ).toThrow(/portForward\.deny is only meaningful when allow is/)
  })

  test('rejects out-of-range port numbers in allow', () => {
    expect(() => configSchema.parse({ models: { default: VALID_MODEL }, portForward: { allow: [99999] } })).toThrow()
  })

  test('rejects out-of-range port numbers in deny', () => {
    expect(() =>
      configSchema.parse({ models: { default: VALID_MODEL }, portForward: { allow: '*', deny: [0] } }),
    ).toThrow()
  })
})

describe('networkSchema', () => {
  const FULL_DEFAULTS = { blockInternal: true, autoAllowResolvers: true, allow: [] as string[] }

  test('defaults to blockInternal:true, autoAllowResolvers:true, allow:[] when omitted (egress filter on for every agent unless opted out)', () => {
    const parsed = configSchema.parse({ models: { default: VALID_MODEL } })
    expect(parsed.network).toEqual(FULL_DEFAULTS)
  })

  test('accepts an empty network object, inheriting all field defaults', () => {
    const parsed = configSchema.parse({ models: { default: VALID_MODEL }, network: {} })
    expect(parsed.network).toEqual(FULL_DEFAULTS)
  })

  test('preserves blockInternal:false when explicitly opted out', () => {
    const parsed = configSchema.parse({ models: { default: VALID_MODEL }, network: { blockInternal: false } })
    expect(parsed.network.blockInternal).toBe(false)
  })

  test('preserves blockInternal:true when explicitly set (redundant with default, but harmless)', () => {
    const parsed = configSchema.parse({ models: { default: VALID_MODEL }, network: { blockInternal: true } })
    expect(parsed.network.blockInternal).toBe(true)
  })

  test('rejects non-boolean blockInternal', () => {
    expect(() => configSchema.parse({ models: { default: VALID_MODEL }, network: { blockInternal: 'yes' } })).toThrow()
    expect(() => configSchema.parse({ models: { default: VALID_MODEL }, network: { blockInternal: 1 } })).toThrow()
  })

  test('preserves autoAllowResolvers:false when explicitly opted out (closed filter for users who configure DNS via .env)', () => {
    const parsed = configSchema.parse({ models: { default: VALID_MODEL }, network: { autoAllowResolvers: false } })
    expect(parsed.network.autoAllowResolvers).toBe(false)
  })

  test('rejects non-boolean autoAllowResolvers', () => {
    expect(() =>
      configSchema.parse({ models: { default: VALID_MODEL }, network: { autoAllowResolvers: 'yes' } }),
    ).toThrow()
  })

  test('accepts bare IPv4 addresses in allow (single-host carve-out: AWS VPC DNS at 10.0.0.2, internal API server, etc.)', () => {
    const parsed = configSchema.parse({
      models: { default: VALID_MODEL },
      network: { allow: ['10.0.0.2', '10.210.1.42'] },
    })
    expect(parsed.network.allow).toEqual(['10.0.0.2', '10.210.1.42'])
  })

  test('accepts IPv4 CIDR ranges in allow (VPC subnet, ECS task subnet, etc.)', () => {
    const parsed = configSchema.parse({
      models: { default: VALID_MODEL },
      network: { allow: ['10.210.0.0/16', '172.20.0.0/24', '192.168.42.0/28'] },
    })
    expect(parsed.network.allow).toEqual(['10.210.0.0/16', '172.20.0.0/24', '192.168.42.0/28'])
  })

  test('rejects non-IPv4 strings in allow (bare hostname, garbage, etc.)', () => {
    expect(() => configSchema.parse({ models: { default: VALID_MODEL }, network: { allow: ['not-a-cidr'] } })).toThrow()
    expect(() =>
      configSchema.parse({ models: { default: VALID_MODEL }, network: { allow: ['example.com'] } }),
    ).toThrow()
  })

  test('rejects out-of-range IPv4 octets in allow (typo guard)', () => {
    expect(() => configSchema.parse({ models: { default: VALID_MODEL }, network: { allow: ['10.0.0.300'] } })).toThrow()
    expect(() =>
      configSchema.parse({ models: { default: VALID_MODEL }, network: { allow: ['999.0.0.0/8'] } }),
    ).toThrow()
  })

  test('rejects out-of-range CIDR prefix lengths in allow', () => {
    expect(() =>
      configSchema.parse({ models: { default: VALID_MODEL }, network: { allow: ['10.0.0.0/33'] } }),
    ).toThrow()
  })

  test('rejects IPv6 addresses in allow (scope is IPv4-only; IPv6 block list is not punched through)', () => {
    expect(() => configSchema.parse({ models: { default: VALID_MODEL }, network: { allow: ['fe80::1'] } })).toThrow()
    expect(() => configSchema.parse({ models: { default: VALID_MODEL }, network: { allow: ['fc00::/7'] } })).toThrow()
  })

  test('rejects non-array allow', () => {
    expect(() => configSchema.parse({ models: { default: VALID_MODEL }, network: { allow: '10.0.0.0/8' } })).toThrow()
  })

  test('does not leak into the plugin config map', () => {
    const plugins = extractPluginConfigs({
      models: { default: VALID_MODEL },
      network: { blockInternal: true, autoAllowResolvers: true, allow: [] },
      'my-plugin': { x: 1 },
    })
    expect('network' in plugins).toBe(false)
    expect(plugins['my-plugin']).toEqual({ x: 1 })
  })
})

describe('docker.file schema', () => {
  const FULL_DEFAULTS = {
    ffmpeg: false,
    gh: true,
    python: true,
    tmux: true,
    cjkFonts: true,
    cloudflared: true,
    xvfb: true,
    claudeCode: false,
    codexCli: false,
    append: [],
  }

  test('defaults to a fully-populated object when omitted (omitted == empty object)', () => {
    const omitted = configSchema.parse({ models: { default: VALID_MODEL } })
    const present = configSchema.parse({ models: { default: VALID_MODEL }, docker: { file: {} } })

    expect(omitted.docker.file).toEqual(FULL_DEFAULTS)
    expect(present.docker.file).toEqual(FULL_DEFAULTS)
  })

  test('accepts custom Dockerfile lines in append order', () => {
    const parsed = configSchema.parse({
      models: { default: VALID_MODEL },
      docker: { file: { append: ['RUN apt-get update', 'ENV CUSTOM_TOOL=1'] } },
    })
    expect(parsed.docker.file.append).toEqual(['RUN apt-get update', 'ENV CUSTOM_TOOL=1'])
  })

  test('rejects multiline append entries so each array item maps to one Dockerfile line', () => {
    expect(() =>
      configSchema.parse({
        models: { default: VALID_MODEL },
        docker: { file: { append: ['RUN printf "one\ntwo"'] } },
      }),
    ).toThrow(/single Dockerfile lines/)
  })

  test('feature toggles accept boolean and version-string forms; partial overrides preserve other defaults', () => {
    const parsed = configSchema.parse({
      models: { default: VALID_MODEL },
      docker: { file: { tmux: false, gh: '2.40.0', ffmpeg: true } },
    })
    expect(parsed.docker.file).toEqual({
      ffmpeg: true,
      gh: '2.40.0',
      python: true,
      tmux: false,
      cjkFonts: true,
      cloudflared: true,
      xvfb: true,
      claudeCode: false,
      codexCli: false,
      append: [],
    })
  })

  test('cjkFonts defaults to true (Chromium renders CJK glyphs correctly out of the box; opt-out saves ~56MB)', () => {
    const parsed = configSchema.parse({ models: { default: VALID_MODEL } })
    expect(parsed.docker.file.cjkFonts).toBe(true)
  })

  test('cjkFonts: false is honored and merges with other defaults', () => {
    const parsed = configSchema.parse({
      models: { default: VALID_MODEL },
      docker: { file: { cjkFonts: false } },
    })
    expect(parsed.docker.file.cjkFonts).toBe(false)
    expect(parsed.docker.file.python).toBe(true)
  })

  test('cjkFonts is boolean-only (the package is a metapackage tracking upstream Noto; no meaningful apt pin)', () => {
    expect(() =>
      configSchema.parse({ models: { default: VALID_MODEL }, docker: { file: { cjkFonts: '2.0' } } }),
    ).toThrow()
  })

  test('cloudflared defaults to true so cloudflare-quick tunnels work on the next start without a separate Dockerfile edit', () => {
    const parsed = configSchema.parse({ models: { default: VALID_MODEL } })
    expect(parsed.docker.file.cloudflared).toBe(true)
  })

  test('cloudflared: true is honored and merges with other defaults', () => {
    const parsed = configSchema.parse({
      models: { default: VALID_MODEL },
      docker: { file: { cloudflared: true } },
    })
    expect(parsed.docker.file.cloudflared).toBe(true)
    expect(parsed.docker.file.python).toBe(true)
  })

  test('cloudflared: false is honored and merges with other defaults', () => {
    const parsed = configSchema.parse({
      models: { default: VALID_MODEL },
      docker: { file: { cloudflared: false } },
    })
    expect(parsed.docker.file.cloudflared).toBe(false)
    expect(parsed.docker.file.gh).toBe(true)
  })

  test('xvfb defaults to true so headed agent-browser works in the container without extra config', () => {
    const parsed = configSchema.parse({ models: { default: VALID_MODEL } })
    expect(parsed.docker.file.xvfb).toBe(true)
  })

  test('xvfb: false is honored and merges with other defaults', () => {
    const parsed = configSchema.parse({
      models: { default: VALID_MODEL },
      docker: { file: { xvfb: false } },
    })
    expect(parsed.docker.file.xvfb).toBe(false)
    expect(parsed.docker.file.python).toBe(true)
  })

  test('xvfb is boolean-only (the package tracks the upstream X server release; no meaningful apt pin)', () => {
    expect(() =>
      configSchema.parse({ models: { default: VALID_MODEL }, docker: { file: { xvfb: '21.1.0' } } }),
    ).toThrow()
  })

  test('python is boolean-only (string version is not a meaningful apt pin for the python3 meta-package)', () => {
    expect(() =>
      configSchema.parse({ models: { default: VALID_MODEL }, docker: { file: { python: '3.11' } } }),
    ).toThrow()
  })

  test('claudeCode is boolean-only (no version-string variant); defaults to false', () => {
    const parsed = configSchema.parse({ model: VALID_MODEL })
    expect(parsed.docker.file.claudeCode).toBe(false)
  })

  test('claudeCode: true is preserved when explicitly enabled', () => {
    const parsed = configSchema.parse({ model: VALID_MODEL, docker: { file: { claudeCode: true } } })
    expect(parsed.docker.file.claudeCode).toBe(true)
  })

  test('claudeCode rejects string version pins (the upstream installer manages versions via env, not apt pins)', () => {
    expect(() => configSchema.parse({ model: VALID_MODEL, docker: { file: { claudeCode: '1.2.3' } } })).toThrow()
  })

  test('codexCli is boolean-only (no version-string variant); defaults to false', () => {
    const parsed = configSchema.parse({ model: VALID_MODEL })
    expect(parsed.docker.file.codexCli).toBe(false)
  })

  test('codexCli: true is preserved when explicitly enabled', () => {
    const parsed = configSchema.parse({ model: VALID_MODEL, docker: { file: { codexCli: true } } })
    expect(parsed.docker.file.codexCli).toBe(true)
  })

  test('codexCli rejects string version pins (the @openai/codex npm package is pinned in the install layer, not via apt-style pins here)', () => {
    expect(() => configSchema.parse({ model: VALID_MODEL, docker: { file: { codexCli: '1.2.3' } } })).toThrow()
  })

  test('empty docker object resolves to defaulted docker.file', () => {
    const parsed = configSchema.parse({ models: { default: VALID_MODEL }, docker: {} })
    expect(parsed.docker.file).toEqual(FULL_DEFAULTS)
  })
})

describe('git.ignore schema', () => {
  test('defaults to an empty append array when omitted', () => {
    const parsed = configSchema.parse({ models: { default: VALID_MODEL } })
    expect(parsed.git.ignore).toEqual({ append: [] })
  })

  test('accepts custom gitignore entries in append order', () => {
    const parsed = configSchema.parse({
      models: { default: VALID_MODEL },
      git: { ignore: { append: ['scratch/', '*.local.log'] } },
    })
    expect(parsed.git.ignore.append).toEqual(['scratch/', '*.local.log'])
  })

  test('defaults append to an empty array when git.ignore object is present', () => {
    const parsed = configSchema.parse({ models: { default: VALID_MODEL }, git: { ignore: {} } })
    expect(parsed.git.ignore).toEqual({ append: [] })
  })

  test('rejects multiline append entries so each array item maps to one gitignore line', () => {
    expect(() =>
      configSchema.parse({
        models: { default: VALID_MODEL },
        git: { ignore: { append: ['scratch/\n*.local.log'] } },
      }),
    ).toThrow(/single gitignore lines/)
  })

  test('empty git object resolves to defaulted git.ignore', () => {
    const parsed = configSchema.parse({ models: { default: VALID_MODEL }, git: {} })
    expect(parsed.git.ignore).toEqual({ append: [] })
  })
})

describe('migrateLegacyConfigShape', () => {
  test('returns input unchanged when seeded github eventAllowlist is absent', () => {
    const input = { models: { default: VALID_MODEL }, port: 9001 }
    const result = migrateLegacyConfigShape(input)
    expect(result.changed).toBe(false)
    expect(result.json).toBe(input)
  })

  test('non-object inputs are returned unchanged', () => {
    expect(migrateLegacyConfigShape(null)).toEqual({ json: null, changed: false, applied: [] })
    expect(migrateLegacyConfigShape([])).toEqual({ json: [], changed: false, applied: [] })
    expect(migrateLegacyConfigShape('string')).toEqual({ json: 'string', changed: false, applied: [] })
  })

  test('loadConfigSync rewrites typeclaw.json on disk when seeded github eventAllowlist is present', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-migrate-'))
    try {
      await writeFile(
        join(cwd, 'typeclaw.json'),
        JSON.stringify({
          models: { default: VALID_MODEL },
          channels: { github: { repos: ['acme/widgets'], eventAllowlist: [...DEFAULT_GITHUB_EVENT_ALLOWLIST] } },
        }),
      )

      const cfg = loadConfigSync(cwd)
      expect(cfg.channels.github?.eventAllowlist).toEqual([...DEFAULT_GITHUB_EVENT_ALLOWLIST])

      const onDisk = JSON.parse(await Bun.file(join(cwd, 'typeclaw.json')).text())
      expect(onDisk.channels.github).toEqual({ repos: ['acme/widgets'] })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('loadConfigSync does not touch the file when no legacy keys are present', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-migrate-noop-'))
    try {
      const original = `${JSON.stringify({ models: { default: VALID_MODEL }, port: 9001 }, null, 4)}\n`
      await writeFile(join(cwd, 'typeclaw.json'), original)

      loadConfigSync(cwd)

      const onDisk = await Bun.file(join(cwd, 'typeclaw.json')).text()
      expect(onDisk).toBe(original)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('validateConfig also performs the on-disk rewrite', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-migrate-validate-'))
    try {
      await writeFile(
        join(cwd, 'typeclaw.json'),
        JSON.stringify({
          models: { default: VALID_MODEL },
          channels: { github: { repos: ['acme/widgets'], eventAllowlist: [...DEFAULT_GITHUB_EVENT_ALLOWLIST] } },
        }),
      )

      const result = validateConfig(cwd)
      expect(result.ok).toBe(true)

      const onDisk = JSON.parse(await Bun.file(join(cwd, 'typeclaw.json')).text())
      expect(onDisk.channels.github).toEqual({ repos: ['acme/widgets'] })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('returns applied: [] when nothing migrated', () => {
    const result = migrateLegacyConfigShape({ models: { default: VALID_MODEL }, port: 9001 })
    expect(result.applied).toEqual([])
  })

  test('strips a seeded channels.github.eventAllowlist so it re-tracks the shipped default', () => {
    const result = migrateLegacyConfigShape({
      models: { default: VALID_MODEL },
      channels: { github: { repos: ['acme/widgets'], eventAllowlist: [...DEFAULT_GITHUB_EVENT_ALLOWLIST] } },
    })
    expect(result.changed).toBe(true)
    const json = result.json as Record<string, unknown>
    const channels = json.channels as Record<string, Record<string, unknown>>
    expect(channels.github).toEqual({ repos: ['acme/widgets'] })
    expect(result.applied).toEqual([{ kind: 'drop-github-seeded-event-allowlist' }])
  })

  // Historical on-disk snapshots seeded by older releases. Inlined verbatim
  // (not imported) so a future edit to the registry can't silently make these
  // assertions pass against the wrong list. See SEEDED_GITHUB_EVENT_ALLOWLISTS.
  const GITHUB_ALLOWLIST_V1 = [
    'issue_comment.created',
    'pull_request_review_comment.created',
    'discussion_comment.created',
    'issues.opened',
    'pull_request.opened',
    'discussion.created',
    'pull_request_review.submitted',
  ]
  const GITHUB_ALLOWLIST_V2 = [
    'issue_comment.created',
    'pull_request_review_comment.created',
    'discussion_comment.created',
    'issues.opened',
    'pull_request.opened',
    'pull_request.review_requested',
    'pull_request.review_request_removed',
    'discussion.created',
    'pull_request_review.submitted',
  ]
  const GITHUB_ALLOWLIST_V3 = [
    'issue_comment.created',
    'pull_request_review_comment.created',
    'discussion_comment.created',
    'issues.opened',
    'pull_request.opened',
    'pull_request.ready_for_review',
    'pull_request.review_requested',
    'pull_request.review_request_removed',
    'discussion.created',
    'pull_request_review.submitted',
  ]

  test.each([
    ['v1 (0.5.1–0.10.0, 7 events)', GITHUB_ALLOWLIST_V1],
    ['v2 (0.11.0+, 9 events)', GITHUB_ALLOWLIST_V2],
    ['v3 (pre-synchronize, 10 events)', GITHUB_ALLOWLIST_V3],
  ])('strips an older seeded github eventAllowlist: %s', (_label, seeded) => {
    const result = migrateLegacyConfigShape({
      models: { default: VALID_MODEL },
      channels: { github: { repos: ['acme/widgets'], eventAllowlist: [...seeded] } },
    })
    expect(result.changed).toBe(true)
    const channels = (result.json as Record<string, unknown>).channels as Record<string, Record<string, unknown>>
    expect(channels.github).toEqual({ repos: ['acme/widgets'] })
    expect(result.applied).toEqual([{ kind: 'drop-github-seeded-event-allowlist' }])
  })

  test('preserves a customized list even when it derives from an older seeded default', () => {
    const customizedFromV1 = [...GITHUB_ALLOWLIST_V1, 'release.published']
    const result = migrateLegacyConfigShape({
      models: { default: VALID_MODEL },
      channels: { github: { eventAllowlist: customizedFromV1 } },
    })
    expect(result.changed).toBe(false)
    const channels = (result.json as Record<string, unknown>).channels as Record<string, Record<string, unknown>>
    expect(channels.github?.eventAllowlist).toEqual(customizedFromV1)
  })

  test('preserves a user-customized github eventAllowlist (any deviation from a seeded default)', () => {
    const customized = [...DEFAULT_GITHUB_EVENT_ALLOWLIST, 'release.published']
    const result = migrateLegacyConfigShape({
      models: { default: VALID_MODEL },
      channels: { github: { repos: ['acme/widgets'], eventAllowlist: customized } },
    })
    expect(result.changed).toBe(false)
    const json = result.json as Record<string, unknown>
    const channels = json.channels as Record<string, Record<string, unknown>>
    expect(channels.github?.eventAllowlist).toEqual(customized)
  })

  test('treats a reordered seeded allowlist as a customization (deep-equal is order-sensitive)', () => {
    const reordered = [
      DEFAULT_GITHUB_EVENT_ALLOWLIST[1],
      DEFAULT_GITHUB_EVENT_ALLOWLIST[0],
      ...DEFAULT_GITHUB_EVENT_ALLOWLIST.slice(2),
    ]
    const result = migrateLegacyConfigShape({
      models: { default: VALID_MODEL },
      channels: { github: { eventAllowlist: reordered } },
    })
    expect(result.changed).toBe(false)
  })

  test('is a no-op when github channel has no eventAllowlist (already canonical)', () => {
    const input = { models: { default: VALID_MODEL }, channels: { github: { repos: ['acme/widgets'] } } }
    const result = migrateLegacyConfigShape(input)
    expect(result.changed).toBe(false)
    expect(result.json).toBe(input)
  })

  test('seeded-allowlist strip is idempotent: re-running on the migrated shape does nothing', () => {
    const first = migrateLegacyConfigShape({
      models: { default: VALID_MODEL },
      channels: { github: { repos: ['acme/widgets'], eventAllowlist: [...DEFAULT_GITHUB_EVENT_ALLOWLIST] } },
    })
    const second = migrateLegacyConfigShape(first.json)
    expect(second.changed).toBe(false)
    expect(second.json).toEqual(first.json)
  })

  test('migrated github config re-parses through configSchema with the schema default applied', () => {
    const result = migrateLegacyConfigShape({
      models: { default: VALID_MODEL },
      channels: { github: { repos: ['acme/widgets'], eventAllowlist: [...DEFAULT_GITHUB_EVENT_ALLOWLIST] } },
    })
    const parsed = configSchema.parse(result.json)
    expect(parsed.channels.github?.eventAllowlist).toEqual([...DEFAULT_GITHUB_EVENT_ALLOWLIST])
  })
})

describe('buildConfigMigrationCommitMessage', () => {
  test('returns null when no steps applied (no commit should be made)', () => {
    expect(buildConfigMigrationCommitMessage([])).toBeNull()
  })

  test('names the github seeded-allowlist drop step', () => {
    const msg = buildConfigMigrationCommitMessage([{ kind: 'drop-github-seeded-event-allowlist' }])
    expect(msg).toContain('typeclaw.json: drop seeded channels.github.eventAllowlist')
    expect(msg).toContain('re-tracks the shipped default')
  })
})

// Closes the gap from PR #179 where typeclaw.json migrations were committed
// only when invoked from `typeclaw start`. The hostd daemon, doctor, tui,
// reload, and compose code paths all reach loadConfigSync / validateConfig /
// loadPluginConfigsSync via independent routes; this describe block asserts
// the commit follows every one of them.
//
// Mutation-check anchor (AGENTS.md §3): removing the commitSystemFileSync
// call inside persistMigratedConfig MUST cause every test in this block to
// fail at the commit-subject assertion.
describe('persistMigratedConfig commits the migration on every entry point', () => {
  async function setupLegacyAgentFolder(prefix: string): Promise<string> {
    const cwd = await mkdtemp(join(tmpdir(), prefix))
    await gitInitForCommitTests(cwd)
    const legacyJson = `${JSON.stringify(
      {
        models: { default: VALID_MODEL },
        channels: { github: { repos: ['acme/widgets'], eventAllowlist: [...DEFAULT_GITHUB_EVENT_ALLOWLIST] } },
      },
      null,
      2,
    )}\n`
    await writeFile(join(cwd, 'typeclaw.json'), legacyJson)
    await runGitForCommitTests(cwd, ['add', 'typeclaw.json'])
    await runGitForCommitTests(cwd, ['commit', '-m', 'initial'])
    return cwd
  }

  test('loadConfigSync triggers the typeclaw.json migration commit', async () => {
    // given: a legacy typeclaw.json committed to a fresh git repo
    const cwd = await setupLegacyAgentFolder('typeclaw-load-commit-')
    try {
      // when: ANY entry point reads the config (e.g. cli/tui, cli/reload)
      loadConfigSync(cwd)

      // then: the migration commit landed in git history
      const subjects = (await runGitForCommitTests(cwd, ['log', '--format=%s'])).split('\n')
      expect(subjects).toContain('typeclaw.json: drop seeded channels.github.eventAllowlist')
      const onDisk = JSON.parse(await readFileText(join(cwd, 'typeclaw.json')))
      const tracked = JSON.parse(await runGitForCommitTests(cwd, ['show', 'HEAD:typeclaw.json']))
      expect(tracked).toEqual(onDisk)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('validateConfig triggers the typeclaw.json migration commit', async () => {
    // given: the same legacy folder (validateConfig is what hostd's restart
    // RPC handler calls before stop()+start())
    const cwd = await setupLegacyAgentFolder('typeclaw-validate-commit-')
    try {
      // when: validateConfig is invoked (the hostd-restart codepath)
      const result = validateConfig(cwd)

      // then: it succeeds AND the commit landed
      expect(result.ok).toBe(true)
      const subjects = (await runGitForCommitTests(cwd, ['log', '--format=%s'])).split('\n')
      expect(subjects).toContain('typeclaw.json: drop seeded channels.github.eventAllowlist')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('loadPluginConfigsSync triggers the typeclaw.json migration commit', async () => {
    // given: a legacy folder (loadPluginConfigsSync is what container-stage
    // `typeclaw run` calls to build the plugin-config map)
    const cwd = await setupLegacyAgentFolder('typeclaw-pluginload-commit-')
    try {
      // when
      loadPluginConfigsSync(cwd)

      // then
      const subjects = (await runGitForCommitTests(cwd, ['log', '--format=%s'])).split('\n')
      expect(subjects).toContain('typeclaw.json: drop seeded channels.github.eventAllowlist')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('a second read after migration is a no-op (idempotent — no duplicate commit)', async () => {
    const cwd = await setupLegacyAgentFolder('typeclaw-idem-commit-')
    try {
      // when: the same entry point is hit twice in succession
      loadConfigSync(cwd)
      const headAfterFirst = await runGitForCommitTests(cwd, ['rev-parse', 'HEAD'])
      loadConfigSync(cwd)
      const headAfterSecond = await runGitForCommitTests(cwd, ['rev-parse', 'HEAD'])

      // then: the second call observed canonical shape and did not commit again
      expect(headAfterSecond).toBe(headAfterFirst)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('on a non-git folder the migration still rewrites the file (commit silently skipped)', async () => {
    // given: a legacy file in a folder with NO .git
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-nogit-commit-'))
    try {
      const legacyJson = `${JSON.stringify(
        {
          models: { default: VALID_MODEL },
          channels: { github: { repos: ['acme/widgets'], eventAllowlist: [...DEFAULT_GITHUB_EVENT_ALLOWLIST] } },
        },
        null,
        2,
      )}\n`
      await writeFile(join(cwd, 'typeclaw.json'), legacyJson)

      // when
      loadConfigSync(cwd)

      // then: the rewrite happened (next start will see canonical), no .git was created
      const onDisk = JSON.parse(await readFileText(join(cwd, 'typeclaw.json')))
      expect(onDisk.channels.github).toEqual({ repos: ['acme/widgets'] })
      expect(existsSync(join(cwd, '.git'))).toBe(false)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('regression: hostd-style read (kakaoChannelConfigured) commits the migration', async () => {
    // given: simulates the user-reported bug — a long-running hostd daemon
    // calls loadConfigSync(cwd) on every kakao-renewal tick. Before this fix
    // those reads silently rewrote typeclaw.json without committing.
    const cwd = await setupLegacyAgentFolder('typeclaw-hostd-style-commit-')
    try {
      // when: the same call shape the daemon's kakaoChannelConfigured uses
      const cfg = loadConfigSync(cwd)
      expect(cfg.channels?.['kakaotalk' as keyof typeof cfg.channels]).toBeUndefined()

      // then: the commit landed in the user's agent repo
      const headContent = JSON.parse(await runGitForCommitTests(cwd, ['show', 'HEAD:typeclaw.json']))
      expect(headContent.channels.github).toEqual({ repos: ['acme/widgets'] })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

async function gitInitForCommitTests(cwd: string): Promise<void> {
  for (const cmd of [
    ['init', '-b', 'main'],
    ['config', 'user.name', 'Test User'],
    ['config', 'user.email', 'test@example.com'],
  ]) {
    const proc = Bun.spawn({ cmd: ['git', ...cmd], cwd, stdout: 'pipe', stderr: 'pipe' })
    await proc.exited
  }
}

async function runGitForCommitTests(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
  await proc.exited
  return (await new Response(proc.stdout).text()).trim()
}

async function readFileText(path: string): Promise<string> {
  return Bun.file(path).text()
}

describe('mountSchema name validation', () => {
  test.each([
    ['lowercase', 'projects'],
    ['digits', 'p1'],
    ['hyphen', 'my-project'],
    ['underscore', 'my_project'],
    ['mixed', 'a1-b2_c3'],
  ])('accepts %s name (%s)', (_kind, name) => {
    expect(() => mountSchema.parse({ name, path: '/x' })).not.toThrow()
  })

  test.each([
    ['empty', ''],
    ['uppercase', 'Projects'],
    ['leading hyphen', '-projects'],
    ['leading underscore', '_projects'],
    ['contains slash', 'my/project'],
    ['contains dot', 'my.project'],
    ['contains space', 'my project'],
  ])('rejects %s name (%s)', (_kind, name) => {
    expect(() => mountSchema.parse({ name, path: '/x' })).toThrow()
  })
})

describe('mountSchema path validation', () => {
  test('rejects empty path', () => {
    expect(() => mountSchema.parse({ name: 'p', path: '' })).toThrow()
  })

  test('accepts absolute path', () => {
    expect(() => mountSchema.parse({ name: 'p', path: '/abs/path' })).not.toThrow()
  })

  test('accepts ~-prefixed path', () => {
    expect(() => mountSchema.parse({ name: 'p', path: '~/notes' })).not.toThrow()
  })

  test("accepts relative path (resolution is the caller's problem)", () => {
    expect(() => mountSchema.parse({ name: 'p', path: './rel' })).not.toThrow()
  })
})

describe('validateConfig', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'typeclaw-validate-'))
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  test('returns ok when typeclaw.json is missing', () => {
    const result = validateConfig(cwd)
    expect(result.ok).toBe(true)
  })

  test('returns ok for a valid config', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ models: { default: VALID_MODEL }, mounts: [] }))
    const result = validateConfig(cwd)
    expect(result.ok).toBe(true)
  })

  test('returns ok for a valid config with a mount whose host path exists, is a directory, and is read-write', async () => {
    const mountDir = join(cwd, 'projects')
    await mkdir(mountDir)
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({ models: { default: VALID_MODEL }, mounts: [{ name: 'projects', path: mountDir }] }),
    )
    const result = validateConfig(cwd)
    expect(result.ok).toBe(true)
  })

  test('fails when a mount path does not exist on the host', async () => {
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({ models: { default: VALID_MODEL }, mounts: [{ name: 'projects', path: join(cwd, 'missing') }] }),
    )
    const result = validateConfig(cwd)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('mount "projects"')
      expect(result.reason).toContain('does not exist')
    }
  })

  test('reports the first failing mount when multiple are broken (matches schema-error shape)', async () => {
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({
        models: { default: VALID_MODEL },
        mounts: [
          { name: 'first', path: join(cwd, 'missing-1') },
          { name: 'second', path: join(cwd, 'missing-2') },
        ],
      }),
    )
    const result = validateConfig(cwd)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('"first"')
      expect(result.reason).not.toContain('"second"')
    }
  })

  test('fails on malformed JSON', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), '{ not json')
    const result = validateConfig(cwd)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('typeclaw.json')
      expect(result.reason).toContain('not valid JSON')
    }
  })

  test('returns ok when mounts is omitted (defaults to [])', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ models: { default: VALID_MODEL } }))
    const result = validateConfig(cwd)
    expect(result.ok).toBe(true)
  })

  test('fails when a mount name violates the pattern', async () => {
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({ models: { default: VALID_MODEL }, mounts: [{ name: 'Bad Name', path: '/x' }] }),
    )
    const result = validateConfig(cwd)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('mount name')
    }
  })

  test('fails when port is out of range', async () => {
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({ models: { default: VALID_MODEL }, mounts: [], port: 99999 }),
    )
    const result = validateConfig(cwd)
    expect(result.ok).toBe(false)
  })
})

describe('validateMount', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'typeclaw-validate-mount-'))
  })

  afterEach(async () => {
    // Best-effort: tests that chmod 000 a path under cwd would otherwise block
    // the cleanup. Restore perms before rm.
    try {
      await chmod(cwd, 0o755)
    } catch {
      // ignore
    }
    await rm(cwd, { recursive: true, force: true })
  })

  test('ok when path exists, is a directory, and is read-write', async () => {
    const dir = join(cwd, 'data')
    await mkdir(dir)
    const result = validateMount({ name: 'data', path: dir, readOnly: false }, cwd)
    expect(result.ok).toBe(true)
  })

  test('fails with "does not exist" when the path is missing', () => {
    const result = validateMount({ name: 'data', path: join(cwd, 'nope'), readOnly: false }, cwd)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('mount "data"')
      expect(result.reason).toContain('does not exist')
    }
  })

  test('fails with "not a directory" when the path is a regular file', async () => {
    const filePath = join(cwd, 'file.txt')
    await writeFile(filePath, 'hi')
    const result = validateMount({ name: 'data', path: filePath, readOnly: false }, cwd)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('mount "data"')
      expect(result.reason).toContain('not a directory')
    }
  })

  test('expands ~ and relative paths via expandMountPath', () => {
    const relative = './does-not-exist-' + Math.random().toString(36).slice(2)
    const result = validateMount({ name: 'data', path: relative, readOnly: false }, cwd)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain(join(cwd, relative.slice(2)))
    }
  })

  test.skipIf(isRoot)('fails when readOnly:false but path is read-only on disk', async () => {
    const dir = join(cwd, 'ro')
    await mkdir(dir)
    await chmod(dir, 0o555)
    try {
      const result = validateMount({ name: 'ro', path: dir, readOnly: false }, cwd)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toContain('not writable')
      }
    } finally {
      await chmod(dir, 0o755)
    }
  })

  test.skipIf(isRoot)('ok when readOnly:true and path is read-only on disk', async () => {
    const dir = join(cwd, 'ro')
    await mkdir(dir)
    await chmod(dir, 0o555)
    try {
      const result = validateMount({ name: 'ro', path: dir, readOnly: true }, cwd)
      expect(result.ok).toBe(true)
    } finally {
      await chmod(dir, 0o755)
    }
  })

  test.skipIf(isRoot)('fails when path is unreadable', async () => {
    const dir = join(cwd, 'noread')
    await mkdir(dir)
    await chmod(dir, 0o000)
    try {
      const result = validateMount({ name: 'noread', path: dir, readOnly: true }, cwd)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toContain('not readable')
      }
    } finally {
      await chmod(dir, 0o755)
    }
  })
})

describe('expandMountPath', () => {
  test('returns absolute paths unchanged', () => {
    expect(expandMountPath('/abs/path', '/cwd')).toBe('/abs/path')
  })

  test('resolves relative paths against cwd', () => {
    expect(expandMountPath('./rel', '/cwd')).toBe('/cwd/rel')
    expect(expandMountPath('rel', '/cwd')).toBe('/cwd/rel')
  })

  test('expands ~ to homedir', () => {
    const expanded = expandMountPath('~/notes', '/cwd')
    expect(expanded.endsWith('/notes')).toBe(true)
    expect(expanded.startsWith('/cwd')).toBe(false)
  })

  test('expands bare ~ to homedir', () => {
    const expanded = expandMountPath('~', '/cwd')
    expect(expanded.startsWith('/cwd')).toBe(false)
    expect(expanded.length).toBeGreaterThan(0)
  })
})

describe('loadConfigSync', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'typeclaw-load-'))
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  test('returns schema defaults when typeclaw.json is missing (fresh agent / dev tree)', () => {
    const cfg = loadConfigSync(cwd)
    expect(cfg.port).toBe(8973)
    expect(cfg.mounts).toEqual([])
  })

  test('reads port from disk', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ models: { default: VALID_MODEL }, port: 9999 }))
    const cfg = loadConfigSync(cwd)
    expect(cfg.port).toBe(9999)
  })

  test('throws on malformed JSON so the user sees the error at startup, not silent fallback', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), '{ not json')
    expect(() => loadConfigSync(cwd)).toThrow(/not valid JSON/)
  })

  test('throws on schema-invalid config (e.g. invalid model name in models.default)', async () => {
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({
        models: { default: 'not-a-known-model' },
      }),
    )
    expect(() => loadConfigSync(cwd)).toThrow(/typeclaw\.json is invalid/)
  })
})

describe('loadConfigSyncOrDefaults', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'typeclaw-load-soft-'))
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  test('returns the real config when typeclaw.json is valid (no warning)', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ models: { default: VALID_MODEL }, port: 9100 }))
    const warnings: string[] = []
    const cfg = loadConfigSyncOrDefaults(cwd, { warn: (msg) => warnings.push(msg) })
    expect(cfg.port).toBe(9100)
    expect(warnings).toEqual([])
  })

  test('returns schema defaults when typeclaw.json is missing (no warning — this is the fresh-agent path)', () => {
    const warnings: string[] = []
    const cfg = loadConfigSyncOrDefaults(cwd, { warn: (msg) => warnings.push(msg) })
    expect(cfg.port).toBe(8973)
    expect(warnings).toEqual([])
  })

  test('returns schema defaults + warning when typeclaw.json is malformed JSON', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), '{ not json')
    const warnings: string[] = []
    const cfg = loadConfigSyncOrDefaults(cwd, { warn: (msg) => warnings.push(msg) })
    expect(cfg.port).toBe(8973)
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toMatch(/not valid JSON/)
    expect(warnings[0]).toMatch(/diagnostic commands still work/)
  })

  test('returns schema defaults + warning when typeclaw.json is schema-invalid', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ models: { default: 'not-a-known-model' } }))
    const warnings: string[] = []
    const cfg = loadConfigSyncOrDefaults(cwd, { warn: (msg) => warnings.push(msg) })
    expect(cfg.port).toBe(8973)
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toMatch(/typeclaw\.json is invalid/)
  })
})

describe('plugin config layout', () => {
  test('plugins defaults to [] when omitted', () => {
    const parsed = configSchema.parse({ models: { default: VALID_MODEL } })
    expect(parsed.plugins).toEqual([])
  })

  test('plugins accepts an array of strings', () => {
    const parsed = configSchema.parse({
      models: { default: VALID_MODEL },
      plugins: ['typeclaw-plugin-foo', './plugins/local'],
    })
    expect(parsed.plugins).toEqual(['typeclaw-plugin-foo', './plugins/local'])
  })

  test('catchall preserves unknown top-level keys (per-plugin config blocks)', () => {
    const parsed = configSchema.parse({
      models: { default: VALID_MODEL },
      plugins: ['typeclaw-plugin-standup-log'],
      'standup-log': { schedule: '0 17 * * 5' },
    }) as Record<string, unknown>
    expect(parsed['standup-log']).toEqual({ schedule: '0 17 * * 5' })
  })

  test('extractPluginConfigs filters known top-level keys and returns the rest (memory now goes to the bundled memory plugin)', () => {
    const result = extractPluginConfigs({
      $schema: 'x',
      port: 1,
      models: { default: VALID_MODEL },
      mounts: [],
      plugins: [],
      memory: { idleMs: 5000 },
      'standup-log': { schedule: '0 17 * * 5' },
    })
    expect(result).toEqual({
      memory: { idleMs: 5000 },
      'standup-log': { schedule: '0 17 * * 5' },
    })
  })

  test('extractPluginConfigs treats portForward, docker, and git as known top-level keys (not plugin blocks)', () => {
    const result = extractPluginConfigs({
      models: { default: VALID_MODEL },
      portForward: { allow: '*' },
      docker: { file: { append: [] } },
      git: { ignore: { append: [] } },
      'standup-log': { schedule: '0 17 * * 5' },
    })
    expect(result).toEqual({ 'standup-log': { schedule: '0 17 * * 5' } })
  })

  test('loadPluginConfigsSync reads per-plugin blocks from disk', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-plugin-cfg-'))
    try {
      await writeFile(
        join(cwd, 'typeclaw.json'),
        JSON.stringify({
          models: { default: VALID_MODEL },
          plugins: ['typeclaw-plugin-foo'],
          foo: { bar: 1 },
        }),
      )
      const result = loadPluginConfigsSync(cwd)
      expect(result).toEqual({ foo: { bar: 1 } })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe('configSchema tunnels field', () => {
  const baseInput = { models: { default: VALID_MODEL } }
  const externalChannel = {
    name: 'github-webhook',
    provider: 'external',
    for: { kind: 'channel', name: 'github' },
    externalUrl: 'https://hook.example.com/',
  }
  const externalManual = {
    name: 'demo',
    provider: 'external',
    for: { kind: 'manual' },
    upstreamPort: 5173,
    externalUrl: 'https://demo.example.com',
  }

  test('defaults to [] when omitted', () => {
    expect(configSchema.parse(baseInput).tunnels).toEqual([])
  })

  test('accepts a channel-linked external tunnel', () => {
    const parsed = configSchema.parse({ ...baseInput, tunnels: [externalChannel] })
    expect(parsed.tunnels).toHaveLength(1)
    expect(parsed.tunnels[0]?.for).toEqual({ kind: 'channel', name: 'github' })
  })

  test('accepts a manual external tunnel with upstreamPort', () => {
    const parsed = configSchema.parse({ ...baseInput, tunnels: [externalManual] })
    expect(parsed.tunnels[0]?.upstreamPort).toBe(5173)
  })

  test('rejects external tunnel without externalUrl', () => {
    expect(() =>
      configSchema.parse({ ...baseInput, tunnels: [{ ...externalChannel, externalUrl: undefined }] }),
    ).toThrow(/externalUrl is required/)
  })

  test('rejects external tunnel with non-https externalUrl', () => {
    expect(() =>
      configSchema.parse({ ...baseInput, tunnels: [{ ...externalChannel, externalUrl: 'http://hook.example.com' }] }),
    ).toThrow(/https:\/\//)
  })

  test('rejects manual tunnel without upstreamPort', () => {
    expect(() =>
      configSchema.parse({ ...baseInput, tunnels: [{ ...externalManual, upstreamPort: undefined }] }),
    ).toThrow(/upstreamPort is required/)
  })

  test('rejects duplicate tunnel names', () => {
    expect(() =>
      configSchema.parse({
        ...baseInput,
        tunnels: [externalChannel, { ...externalChannel, externalUrl: 'https://other.example.com' }],
      }),
    ).toThrow(/duplicates tunnels/)
  })

  test('rejects names that do not match the kebab-case regex', () => {
    expect(() => configSchema.parse({ ...baseInput, tunnels: [{ ...externalChannel, name: 'Has Caps' }] })).toThrow()
    expect(() =>
      configSchema.parse({ ...baseInput, tunnels: [{ ...externalChannel, name: '-leading-dash' }] }),
    ).toThrow()
  })

  test('accepts cloudflare-quick and still rejects unsupported provider strings', () => {
    const parsed = configSchema.parse({ ...baseInput, tunnels: [{ ...externalChannel, provider: 'cloudflare-quick' }] })
    expect(parsed.tunnels[0]?.provider).toBe('cloudflare-quick')
    expect(() =>
      configSchema.parse({ ...baseInput, tunnels: [{ ...externalChannel, provider: 'wireguard' }] }),
    ).toThrow()
  })

  test('rejects a channel for-discriminator with an empty name', () => {
    expect(() =>
      configSchema.parse({ ...baseInput, tunnels: [{ ...externalChannel, for: { kind: 'channel', name: '   ' } }] }),
    ).toThrow()
  })

  describe('cloudflare-named provider', () => {
    const namedChannel = {
      name: 'github-webhook',
      provider: 'cloudflare-named',
      for: { kind: 'channel', name: 'github' },
      hostname: 'https://agent.example.com',
      tokenEnv: 'CLOUDFLARE_TUNNEL_TOKEN',
    }

    test('accepts a channel-linked named tunnel with hostname and tokenEnv', () => {
      const parsed = configSchema.parse({ ...baseInput, tunnels: [namedChannel] })
      expect(parsed.tunnels[0]?.provider).toBe('cloudflare-named')
      expect(parsed.tunnels[0]?.hostname).toBe('https://agent.example.com')
      expect(parsed.tunnels[0]?.tokenEnv).toBe('CLOUDFLARE_TUNNEL_TOKEN')
    })

    test('accepts a manual named tunnel without upstreamPort', () => {
      const parsed = configSchema.parse({
        ...baseInput,
        tunnels: [{ ...namedChannel, for: { kind: 'manual' } }],
      })
      expect(parsed.tunnels[0]?.for).toEqual({ kind: 'manual' })
      expect(parsed.tunnels[0]?.upstreamPort).toBeUndefined()
    })

    test('rejects named tunnel without hostname', () => {
      expect(() => configSchema.parse({ ...baseInput, tunnels: [{ ...namedChannel, hostname: undefined }] })).toThrow(
        /hostname is required/,
      )
    })

    test('rejects named tunnel with non-https hostname', () => {
      expect(() =>
        configSchema.parse({ ...baseInput, tunnels: [{ ...namedChannel, hostname: 'http://agent.example.com' }] }),
      ).toThrow(/https:\/\//)
    })

    test('rejects named tunnel without tokenEnv', () => {
      expect(() => configSchema.parse({ ...baseInput, tunnels: [{ ...namedChannel, tokenEnv: undefined }] })).toThrow(
        /tokenEnv is required/,
      )
    })

    test('rejects named tunnel with lowercase tokenEnv', () => {
      expect(() => configSchema.parse({ ...baseInput, tunnels: [{ ...namedChannel, tokenEnv: 'my_token' }] })).toThrow(
        /env var name/,
      )
    })

    test('rejects named tunnel with upstreamPort set', () => {
      expect(() => configSchema.parse({ ...baseInput, tunnels: [{ ...namedChannel, upstreamPort: 8080 }] })).toThrow(
        /upstreamPort must not be set/,
      )
    })
  })
})
