import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  configSchema,
  extractPluginConfigs,
  expandMountPath,
  loadConfigSync,
  loadPluginConfigsSync,
  migrateLegacyConfigShape,
  mountSchema,
  validateConfig,
  validateMount,
} from './config'

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

const VALID_MODEL = 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo'

describe('configSchema', () => {
  test('defaults mounts to [] when omitted (predating the field is fine)', () => {
    const parsed = configSchema.parse({ model: VALID_MODEL })
    expect(parsed.mounts).toEqual([])
  })

  test('accepts config with empty mounts array', () => {
    const parsed = configSchema.parse({ model: VALID_MODEL, mounts: [] })
    expect(parsed.mounts).toEqual([])
  })

  test('accepts config with one mount, defaulting readOnly to false', () => {
    const parsed = configSchema.parse({
      model: VALID_MODEL,
      mounts: [{ name: 'projects', path: '~/projects' }],
    })
    expect(parsed.mounts).toEqual([{ name: 'projects', path: '~/projects', readOnly: false }])
  })

  test('preserves readOnly: true when provided', () => {
    const parsed = configSchema.parse({
      model: VALID_MODEL,
      mounts: [{ name: 'notes', path: '~/notes', readOnly: true }],
    })
    expect(parsed.mounts[0]?.readOnly).toBe(true)
  })

  test('preserves description when provided', () => {
    const parsed = configSchema.parse({
      model: VALID_MODEL,
      mounts: [{ name: 'src', path: '~/src', description: 'monorepo' }],
    })
    expect(parsed.mounts[0]?.description).toBe('monorepo')
  })
})

describe('configSchema alias field', () => {
  test('defaults to [] when omitted', () => {
    const parsed = configSchema.parse({ model: VALID_MODEL })
    expect(parsed.alias).toEqual([])
  })

  test('accepts a non-empty alias array', () => {
    const parsed = configSchema.parse({ model: VALID_MODEL, alias: ['bongbong', '봉봉'] })
    expect(parsed.alias).toEqual(['bongbong', '봉봉'])
  })

  test('trims surrounding whitespace from each entry', () => {
    const parsed = configSchema.parse({ model: VALID_MODEL, alias: ['  bongbong  ', '\t봉봉\n'] })
    expect(parsed.alias).toEqual(['bongbong', '봉봉'])
  })

  test('rejects empty-string entries', () => {
    expect(() => configSchema.parse({ model: VALID_MODEL, alias: [''] })).toThrow()
  })

  test('rejects whitespace-only entries (would otherwise match every message after trim)', () => {
    expect(() => configSchema.parse({ model: VALID_MODEL, alias: ['   '] })).toThrow()
  })
})

describe('configSchema preserves unknown top-level keys (plugin config blocks)', () => {
  test('a top-level "memory" block survives the schema as unknown (consumed by the bundled memory plugin)', () => {
    const parsed = configSchema.parse({
      model: VALID_MODEL,
      memory: { idleMs: 60_000, dreaming: { schedule: '30 3 * * *' } },
    })
    expect(parsed['memory']).toEqual({ idleMs: 60_000, dreaming: { schedule: '30 3 * * *' } })
  })

  test('agentBrowser is treated as plugin/user config instead of a core key', () => {
    const configs = extractPluginConfigs({
      model: VALID_MODEL,
      agentBrowser: { dashboardProxy: false },
      customPlugin: { enabled: true },
    })

    expect(configs).toEqual({ agentBrowser: { dashboardProxy: false }, customPlugin: { enabled: true } })
  })
})

describe('portForwardSchema', () => {
  test('defaults to allow:* when omitted', () => {
    const parsed = configSchema.parse({ model: VALID_MODEL })
    expect(parsed.portForward).toEqual({ allow: '*' })
  })

  test('accepts allow:* with no deny', () => {
    const parsed = configSchema.parse({ model: VALID_MODEL, portForward: { allow: '*' } })
    expect(parsed.portForward).toEqual({ allow: '*' })
  })

  test('accepts allow:* with deny list', () => {
    const parsed = configSchema.parse({ model: VALID_MODEL, portForward: { allow: '*', deny: [9229, 9999] } })
    expect(parsed.portForward).toEqual({ allow: '*', deny: [9229, 9999] })
  })

  test('accepts allow as number array (allowlist mode)', () => {
    const parsed = configSchema.parse({ model: VALID_MODEL, portForward: { allow: [3000, 5173] } })
    expect(parsed.portForward).toEqual({ allow: [3000, 5173] })
  })

  test('accepts allow:[] as off-switch', () => {
    const parsed = configSchema.parse({ model: VALID_MODEL, portForward: { allow: [] } })
    expect(parsed.portForward).toEqual({ allow: [] })
  })

  test('rejects deny combined with allow:number[] so user typos do not silently drop the deny rule', () => {
    expect(() => configSchema.parse({ model: VALID_MODEL, portForward: { allow: [3000], deny: [9000] } })).toThrow(
      /portForward\.deny is only meaningful when allow is/,
    )
  })

  test('rejects out-of-range port numbers in allow', () => {
    expect(() => configSchema.parse({ model: VALID_MODEL, portForward: { allow: [99999] } })).toThrow()
  })

  test('rejects out-of-range port numbers in deny', () => {
    expect(() => configSchema.parse({ model: VALID_MODEL, portForward: { allow: '*', deny: [0] } })).toThrow()
  })
})

describe('networkSchema', () => {
  const FULL_DEFAULTS = { blockInternal: true, autoAllowResolvers: true, allow: [] as string[] }

  test('defaults to blockInternal:true, autoAllowResolvers:true, allow:[] when omitted (egress filter on for every agent unless opted out)', () => {
    const parsed = configSchema.parse({ model: VALID_MODEL })
    expect(parsed.network).toEqual(FULL_DEFAULTS)
  })

  test('accepts an empty network object, inheriting all field defaults', () => {
    const parsed = configSchema.parse({ model: VALID_MODEL, network: {} })
    expect(parsed.network).toEqual(FULL_DEFAULTS)
  })

  test('preserves blockInternal:false when explicitly opted out', () => {
    const parsed = configSchema.parse({ model: VALID_MODEL, network: { blockInternal: false } })
    expect(parsed.network.blockInternal).toBe(false)
  })

  test('preserves blockInternal:true when explicitly set (redundant with default, but harmless)', () => {
    const parsed = configSchema.parse({ model: VALID_MODEL, network: { blockInternal: true } })
    expect(parsed.network.blockInternal).toBe(true)
  })

  test('rejects non-boolean blockInternal', () => {
    expect(() => configSchema.parse({ model: VALID_MODEL, network: { blockInternal: 'yes' } })).toThrow()
    expect(() => configSchema.parse({ model: VALID_MODEL, network: { blockInternal: 1 } })).toThrow()
  })

  test('preserves autoAllowResolvers:false when explicitly opted out (closed filter for users who configure DNS via .env)', () => {
    const parsed = configSchema.parse({ model: VALID_MODEL, network: { autoAllowResolvers: false } })
    expect(parsed.network.autoAllowResolvers).toBe(false)
  })

  test('rejects non-boolean autoAllowResolvers', () => {
    expect(() => configSchema.parse({ model: VALID_MODEL, network: { autoAllowResolvers: 'yes' } })).toThrow()
  })

  test('accepts bare IPv4 addresses in allow (single-host carve-out: AWS VPC DNS at 10.0.0.2, internal API server, etc.)', () => {
    const parsed = configSchema.parse({ model: VALID_MODEL, network: { allow: ['10.0.0.2', '10.210.1.42'] } })
    expect(parsed.network.allow).toEqual(['10.0.0.2', '10.210.1.42'])
  })

  test('accepts IPv4 CIDR ranges in allow (VPC subnet, ECS task subnet, etc.)', () => {
    const parsed = configSchema.parse({
      model: VALID_MODEL,
      network: { allow: ['10.210.0.0/16', '172.20.0.0/24', '192.168.42.0/28'] },
    })
    expect(parsed.network.allow).toEqual(['10.210.0.0/16', '172.20.0.0/24', '192.168.42.0/28'])
  })

  test('rejects non-IPv4 strings in allow (bare hostname, garbage, etc.)', () => {
    expect(() => configSchema.parse({ model: VALID_MODEL, network: { allow: ['not-a-cidr'] } })).toThrow()
    expect(() => configSchema.parse({ model: VALID_MODEL, network: { allow: ['example.com'] } })).toThrow()
  })

  test('rejects out-of-range IPv4 octets in allow (typo guard)', () => {
    expect(() => configSchema.parse({ model: VALID_MODEL, network: { allow: ['10.0.0.300'] } })).toThrow()
    expect(() => configSchema.parse({ model: VALID_MODEL, network: { allow: ['999.0.0.0/8'] } })).toThrow()
  })

  test('rejects out-of-range CIDR prefix lengths in allow', () => {
    expect(() => configSchema.parse({ model: VALID_MODEL, network: { allow: ['10.0.0.0/33'] } })).toThrow()
  })

  test('rejects IPv6 addresses in allow (scope is IPv4-only; IPv6 block list is not punched through)', () => {
    expect(() => configSchema.parse({ model: VALID_MODEL, network: { allow: ['fe80::1'] } })).toThrow()
    expect(() => configSchema.parse({ model: VALID_MODEL, network: { allow: ['fc00::/7'] } })).toThrow()
  })

  test('rejects non-array allow', () => {
    expect(() => configSchema.parse({ model: VALID_MODEL, network: { allow: '10.0.0.0/8' } })).toThrow()
  })

  test('does not leak into the plugin config map', () => {
    const plugins = extractPluginConfigs({
      model: VALID_MODEL,
      network: { blockInternal: true, autoAllowResolvers: true, allow: [] },
      'my-plugin': { x: 1 },
    })
    expect('network' in plugins).toBe(false)
    expect(plugins['my-plugin']).toEqual({ x: 1 })
  })
})

describe('dockerfileSchema', () => {
  const FULL_DEFAULTS = { ffmpeg: false, gh: true, python: true, tmux: true, append: [] }

  test('defaults to a fully-populated object when omitted (omitted == empty object)', () => {
    const omitted = configSchema.parse({ model: VALID_MODEL })
    const present = configSchema.parse({ model: VALID_MODEL, dockerfile: {} })

    expect(omitted.dockerfile).toEqual(FULL_DEFAULTS)
    expect(present.dockerfile).toEqual(FULL_DEFAULTS)
  })

  test('accepts custom Dockerfile lines in append order', () => {
    const parsed = configSchema.parse({
      model: VALID_MODEL,
      dockerfile: { append: ['RUN apt-get update', 'ENV CUSTOM_TOOL=1'] },
    })
    expect(parsed.dockerfile.append).toEqual(['RUN apt-get update', 'ENV CUSTOM_TOOL=1'])
  })

  test('rejects multiline append entries so each array item maps to one Dockerfile line', () => {
    expect(() =>
      configSchema.parse({
        model: VALID_MODEL,
        dockerfile: { append: ['RUN printf "one\ntwo"'] },
      }),
    ).toThrow(/single Dockerfile lines/)
  })

  test('feature toggles accept boolean and version-string forms; partial overrides preserve other defaults', () => {
    const parsed = configSchema.parse({
      model: VALID_MODEL,
      dockerfile: { tmux: false, gh: '2.40.0', ffmpeg: true },
    })
    expect(parsed.dockerfile).toEqual({
      ffmpeg: true,
      gh: '2.40.0',
      python: true,
      tmux: false,
      append: [],
    })
  })

  test('python is boolean-only (string version is not a meaningful apt pin for the python3 meta-package)', () => {
    expect(() => configSchema.parse({ model: VALID_MODEL, dockerfile: { python: '3.11' } })).toThrow()
  })
})

describe('gitignoreSchema', () => {
  test('defaults to an empty append array when omitted', () => {
    const parsed = configSchema.parse({ model: VALID_MODEL })
    expect(parsed.gitignore).toEqual({ append: [] })
  })

  test('accepts custom gitignore entries in append order', () => {
    const parsed = configSchema.parse({
      model: VALID_MODEL,
      gitignore: { append: ['scratch/', '*.local.log'] },
    })
    expect(parsed.gitignore.append).toEqual(['scratch/', '*.local.log'])
  })

  test('defaults append to an empty array when gitignore object is present', () => {
    const parsed = configSchema.parse({ model: VALID_MODEL, gitignore: {} })
    expect(parsed.gitignore).toEqual({ append: [] })
  })

  test('rejects multiline append entries so each array item maps to one gitignore line', () => {
    expect(() =>
      configSchema.parse({
        model: VALID_MODEL,
        gitignore: { append: ['scratch/\n*.local.log'] },
      }),
    ).toThrow(/single gitignore lines/)
  })
})

describe('migrateLegacyConfigShape', () => {
  test('returns input unchanged when neither legacy key is present', () => {
    const input = { model: VALID_MODEL, port: 9001 }
    const result = migrateLegacyConfigShape(input)
    expect(result.changed).toBe(false)
    expect(result.json).toBe(input)
  })

  test('moves legacy dockerfile into docker.file', () => {
    const result = migrateLegacyConfigShape({
      model: VALID_MODEL,
      dockerfile: { ffmpeg: true, append: ['ENV X=1'] },
    })
    expect(result.changed).toBe(true)
    expect(result.json).toEqual({
      model: VALID_MODEL,
      docker: { file: { ffmpeg: true, append: ['ENV X=1'] } },
    })
  })

  test('moves legacy gitignore into git.ignore', () => {
    const result = migrateLegacyConfigShape({
      model: VALID_MODEL,
      gitignore: { append: ['scratch/'] },
    })
    expect(result.changed).toBe(true)
    expect(result.json).toEqual({
      model: VALID_MODEL,
      git: { ignore: { append: ['scratch/'] } },
    })
  })

  test('migrates both legacy keys in a single pass', () => {
    const result = migrateLegacyConfigShape({
      model: VALID_MODEL,
      dockerfile: { ffmpeg: true },
      gitignore: { append: ['scratch/'] },
    })
    expect(result.changed).toBe(true)
    expect(result.json).toEqual({
      model: VALID_MODEL,
      docker: { file: { ffmpeg: true } },
      git: { ignore: { append: ['scratch/'] } },
    })
  })

  test('drops legacy dockerfile when new docker.file already present (new shape wins)', () => {
    const result = migrateLegacyConfigShape({
      model: VALID_MODEL,
      dockerfile: { ffmpeg: false, append: ['LEGACY'] },
      docker: { file: { ffmpeg: true, append: ['NEW'] } },
    })
    expect(result.changed).toBe(true)
    expect(result.json).toEqual({
      model: VALID_MODEL,
      docker: { file: { ffmpeg: true, append: ['NEW'] } },
    })
  })

  test('drops legacy gitignore when new git.ignore already present (new shape wins)', () => {
    const result = migrateLegacyConfigShape({
      model: VALID_MODEL,
      gitignore: { append: ['LEGACY'] },
      git: { ignore: { append: ['NEW'] } },
    })
    expect(result.changed).toBe(true)
    expect(result.json).toEqual({
      model: VALID_MODEL,
      git: { ignore: { append: ['NEW'] } },
    })
  })

  test('merges legacy dockerfile into existing docker namespace that lacks file', () => {
    const result = migrateLegacyConfigShape({
      model: VALID_MODEL,
      dockerfile: { ffmpeg: true },
      docker: { somethingElse: 'future' },
    })
    expect(result.changed).toBe(true)
    expect(result.json).toEqual({
      model: VALID_MODEL,
      docker: { somethingElse: 'future', file: { ffmpeg: true } },
    })
  })

  test('non-object inputs are returned unchanged', () => {
    expect(migrateLegacyConfigShape(null)).toEqual({ json: null, changed: false })
    expect(migrateLegacyConfigShape([])).toEqual({ json: [], changed: false })
    expect(migrateLegacyConfigShape('string')).toEqual({ json: 'string', changed: false })
  })
})

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
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: VALID_MODEL, mounts: [] }))
    const result = validateConfig(cwd)
    expect(result.ok).toBe(true)
  })

  test('returns ok for a valid config with a mount whose host path exists, is a directory, and is read-write', async () => {
    const mountDir = join(cwd, 'projects')
    await mkdir(mountDir)
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({ model: VALID_MODEL, mounts: [{ name: 'projects', path: mountDir }] }),
    )
    const result = validateConfig(cwd)
    expect(result.ok).toBe(true)
  })

  test('fails when a mount path does not exist on the host', async () => {
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({ model: VALID_MODEL, mounts: [{ name: 'projects', path: join(cwd, 'missing') }] }),
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
        model: VALID_MODEL,
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
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: VALID_MODEL }))
    const result = validateConfig(cwd)
    expect(result.ok).toBe(true)
  })

  test('fails when a mount name violates the pattern', async () => {
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({ model: VALID_MODEL, mounts: [{ name: 'Bad Name', path: '/x' }] }),
    )
    const result = validateConfig(cwd)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('mount name')
    }
  })

  test('fails when port is out of range', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: VALID_MODEL, mounts: [], port: 99999 }))
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
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: VALID_MODEL, port: 9999 }))
    const cfg = loadConfigSync(cwd)
    expect(cfg.port).toBe(9999)
  })

  test('throws on malformed JSON so the user sees the error at startup, not silent fallback', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), '{ not json')
    expect(() => loadConfigSync(cwd)).toThrow(/not valid JSON/)
  })

  test('throws on schema-invalid config (e.g. invalid model name)', async () => {
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({
        model: 'not-a-known-model',
      }),
    )
    expect(() => loadConfigSync(cwd)).toThrow(/typeclaw\.json is invalid/)
  })
})

describe('plugin config layout', () => {
  test('plugins defaults to [] when omitted', () => {
    const parsed = configSchema.parse({ model: VALID_MODEL })
    expect(parsed.plugins).toEqual([])
  })

  test('plugins accepts an array of strings', () => {
    const parsed = configSchema.parse({
      model: VALID_MODEL,
      plugins: ['typeclaw-plugin-foo', './plugins/local'],
    })
    expect(parsed.plugins).toEqual(['typeclaw-plugin-foo', './plugins/local'])
  })

  test('catchall preserves unknown top-level keys (per-plugin config blocks)', () => {
    const parsed = configSchema.parse({
      model: VALID_MODEL,
      plugins: ['typeclaw-plugin-standup-log'],
      'standup-log': { schedule: '0 17 * * 5' },
    }) as Record<string, unknown>
    expect(parsed['standup-log']).toEqual({ schedule: '0 17 * * 5' })
  })

  test('extractPluginConfigs filters known top-level keys and returns the rest (memory now goes to the bundled memory plugin)', () => {
    const result = extractPluginConfigs({
      $schema: 'x',
      port: 1,
      model: 'm',
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

  test('extractPluginConfigs treats portForward as a known top-level key (not a plugin block)', () => {
    const result = extractPluginConfigs({
      model: VALID_MODEL,
      portForward: { allow: '*' },
      dockerfile: { append: [] },
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
          model: VALID_MODEL,
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
