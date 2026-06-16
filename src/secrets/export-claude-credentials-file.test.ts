import { describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isWindows } from '@/shared'

import { exportClaudeCredentialsFileIfApplicable } from './export-claude-credentials-file'
import type { Providers } from './schema'

const onWindows = isWindows()

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.sig`
}

function oauthProviders(opts: {
  access?: string
  refresh?: string
  expires?: number
  scopes?: string[]
  subscriptionType?: string
}): Providers {
  return {
    anthropic: {
      type: 'oauth',
      access: opts.access ?? makeJwt({ exp: 2_000_000_000 }),
      refresh: opts.refresh ?? 'refresh-token',
      expires: opts.expires ?? 2_000_000_000_000,
      ...(opts.scopes !== undefined ? { scopes: opts.scopes } : {}),
      ...(opts.subscriptionType !== undefined ? { subscriptionType: opts.subscriptionType } : {}),
    } as never,
  }
}

async function withHome<T>(fn: (home: string) => Promise<T> | T): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'typeclaw-claude-export-'))
  try {
    return await fn(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

describe('exportClaudeCredentialsFileIfApplicable', () => {
  test('claudeCode disabled → skip without touching the filesystem', async () => {
    await withHome((home) => {
      const result = exportClaudeCredentialsFileIfApplicable({
        claudeCodeEnabled: false,
        providers: oauthProviders({}),
        homeDir: home,
      })
      expect(result).toEqual({ action: 'skipped', reason: 'claude-code-disabled' })
      expect(existsSync(join(home, '.claude'))).toBe(false)
    })
  })

  test('anthropic provider absent → skip', async () => {
    await withHome((home) => {
      const result = exportClaudeCredentialsFileIfApplicable({
        claudeCodeEnabled: true,
        providers: {},
        homeDir: home,
      })
      expect(result).toEqual({ action: 'skipped', reason: 'no-anthropic-credential' })
      expect(existsSync(join(home, '.claude'))).toBe(false)
    })
  })

  test('skips when anthropic credential is api-key shape (defensive)', async () => {
    await withHome((home) => {
      const providers: Providers = {
        anthropic: { type: 'api_key', key: { value: 'sk-ant-x' } } as never,
      }
      const result = exportClaudeCredentialsFileIfApplicable({
        claudeCodeEnabled: true,
        providers,
        homeDir: home,
      })
      expect(result).toEqual({ action: 'skipped', reason: 'credential-not-oauth' })
      expect(existsSync(join(home, '.claude'))).toBe(false)
    })
  })

  test('no .credentials.json yet → writes from secrets.json', async () => {
    await withHome((home) => {
      const result = exportClaudeCredentialsFileIfApplicable({
        claudeCodeEnabled: true,
        providers: oauthProviders({
          access: makeJwt({ exp: 2_000_000_000 }),
          refresh: 'refresh-1',
          scopes: ['user:inference', 'user:profile'],
          subscriptionType: 'max',
        }),
        homeDir: home,
      })
      expect(result.action).toBe('wrote')
      const target = join(home, '.claude', '.credentials.json')
      expect(existsSync(target)).toBe(true)
      const parsed = JSON.parse(readFileSync(target, 'utf8')) as {
        claudeAiOauth: { accessToken: string; refreshToken: string; scopes?: string[]; subscriptionType?: string }
      }
      expect(parsed.claudeAiOauth.refreshToken).toBe('refresh-1')
      expect(parsed.claudeAiOauth.scopes).toEqual(['user:inference', 'user:profile'])
      expect(parsed.claudeAiOauth.subscriptionType).toBe('max')
    })
  })

  test('CLAUDE_CONFIG_DIR writes .credentials.json there instead of the default ~/.claude path', async () => {
    await withHome(async (home) => {
      const configDir = join(home, 'custom-claude-config')
      const result = exportClaudeCredentialsFileIfApplicable({
        claudeCodeEnabled: true,
        providers: oauthProviders({ refresh: 'config-dir-refresh' }),
        homeDir: home,
        configDir,
      })
      expect(result).toEqual({ action: 'wrote', path: join(configDir, '.credentials.json') })
      expect(existsSync(join(configDir, '.credentials.json'))).toBe(true)
      expect(existsSync(join(home, '.claude', '.credentials.json'))).toBe(false)
      const parsed = JSON.parse(readFileSync(join(configDir, '.credentials.json'), 'utf8')) as {
        claudeAiOauth: { refreshToken: string }
      }
      expect(parsed.claudeAiOauth.refreshToken).toBe('config-dir-refresh')
    })
  })

  test('writes with 0600 file mode (refresh token is long-lived)', async () => {
    await withHome((home) => {
      exportClaudeCredentialsFileIfApplicable({
        claudeCodeEnabled: true,
        providers: oauthProviders({}),
        homeDir: home,
      })
      const stat = statSync(join(home, '.claude', '.credentials.json'))
      // NTFS mode bits are not meaningful on Windows; see #899.
      if (!onWindows) expect(stat.mode & 0o777).toBe(0o600)
    })
  })

  test('existing file with strictly later JWT exp → skip (Claude Code refreshed in-place)', async () => {
    await withHome((home) => {
      mkdirSync(join(home, '.claude'), { recursive: true })
      const freshAccess = makeJwt({ exp: 3_000_000_000 })
      writeFileSync(
        join(home, '.claude', '.credentials.json'),
        JSON.stringify({
          claudeAiOauth: { accessToken: freshAccess, refreshToken: 'claude-refreshed', expiresAt: 3_000_000_000_000 },
        }),
      )
      const result = exportClaudeCredentialsFileIfApplicable({
        claudeCodeEnabled: true,
        providers: oauthProviders({
          access: makeJwt({ exp: 1_000_000_000 }),
          expires: 1_000_000_000_000,
        }),
        homeDir: home,
      })
      expect(result).toEqual({ action: 'skipped', reason: 'on-disk-is-fresher' })
      const after = JSON.parse(readFileSync(join(home, '.claude', '.credentials.json'), 'utf8')) as {
        claudeAiOauth: { refreshToken: string }
      }
      expect(after.claudeAiOauth.refreshToken).toBe('claude-refreshed')
    })
  })

  test('existing file with opaque access token and later expiresAt → skip without clobbering rotated refresh token', async () => {
    await withHome((home) => {
      mkdirSync(join(home, '.claude'), { recursive: true })
      writeFileSync(
        join(home, '.claude', '.credentials.json'),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'sk-ant-oat01-rotated',
            refreshToken: 'sk-ant-ort01-rotated',
            expiresAt: 2_000_000_000_000,
          },
        }),
      )
      const result = exportClaudeCredentialsFileIfApplicable({
        claudeCodeEnabled: true,
        providers: oauthProviders({
          access: 'sk-ant-oat01-incoming',
          refresh: 'sk-ant-ort01-incoming',
          expires: 1_900_000_000_000,
        }),
        homeDir: home,
      })
      expect(result).toEqual({ action: 'skipped', reason: 'on-disk-is-fresher' })
      const after = JSON.parse(readFileSync(join(home, '.claude', '.credentials.json'), 'utf8')) as {
        claudeAiOauth: { refreshToken: string }
      }
      expect(after.claudeAiOauth.refreshToken).toBe('sk-ant-ort01-rotated')
    })
  })

  test('existing file with older JWT exp → overwrite (user re-pasted via wizard)', async () => {
    await withHome((home) => {
      mkdirSync(join(home, '.claude'), { recursive: true })
      const staleAccess = makeJwt({ exp: 1_000_000_000 })
      writeFileSync(
        join(home, '.claude', '.credentials.json'),
        JSON.stringify({
          claudeAiOauth: { accessToken: staleAccess, refreshToken: 'stale-refresh', expiresAt: 1_000_000_000_000 },
        }),
      )
      const result = exportClaudeCredentialsFileIfApplicable({
        claudeCodeEnabled: true,
        providers: oauthProviders({
          access: makeJwt({ exp: 3_000_000_000 }),
          refresh: 'fresh-refresh',
          expires: 3_000_000_000_000,
        }),
        homeDir: home,
      })
      expect(result.action).toBe('wrote')
      const after = JSON.parse(readFileSync(join(home, '.claude', '.credentials.json'), 'utf8')) as {
        claudeAiOauth: { refreshToken: string }
      }
      expect(after.claudeAiOauth.refreshToken).toBe('fresh-refresh')
    })
  })

  test('tie on JWT exp → skip (steady state at zero churn)', async () => {
    await withHome((home) => {
      mkdirSync(join(home, '.claude'), { recursive: true })
      const tied = makeJwt({ exp: 2_000_000_000 })
      writeFileSync(
        join(home, '.claude', '.credentials.json'),
        JSON.stringify({
          claudeAiOauth: { accessToken: tied, refreshToken: 'on-disk', expiresAt: 2_000_000_000_000 },
        }),
      )
      const result = exportClaudeCredentialsFileIfApplicable({
        claudeCodeEnabled: true,
        providers: oauthProviders({ access: tied, refresh: 'in-secrets', expires: 2_000_000_000_000 }),
        homeDir: home,
      })
      expect(result).toEqual({ action: 'skipped', reason: 'on-disk-is-fresher' })
      const after = JSON.parse(readFileSync(join(home, '.claude', '.credentials.json'), 'utf8')) as {
        claudeAiOauth: { refreshToken: string }
      }
      expect(after.claudeAiOauth.refreshToken).toBe('on-disk')
    })
  })

  test('preserves an existing mcpOAuth block on overwrite (read-merge-write)', async () => {
    await withHome((home) => {
      mkdirSync(join(home, '.claude'), { recursive: true })
      const staleAccess = makeJwt({ exp: 1_000_000_000 })
      const mcpBlock = { 'server-x': { tokens: { access_token: 'mcp-at' } } }
      writeFileSync(
        join(home, '.claude', '.credentials.json'),
        JSON.stringify({
          claudeAiOauth: { accessToken: staleAccess, refreshToken: 'stale', expiresAt: 1_000_000_000_000 },
          mcpOAuth: mcpBlock,
        }),
      )
      const result = exportClaudeCredentialsFileIfApplicable({
        claudeCodeEnabled: true,
        providers: oauthProviders({
          access: makeJwt({ exp: 3_000_000_000 }),
          refresh: 'fresh',
          expires: 3_000_000_000_000,
        }),
        homeDir: home,
      })
      expect(result.action).toBe('wrote')
      const after = JSON.parse(readFileSync(join(home, '.claude', '.credentials.json'), 'utf8')) as {
        claudeAiOauth: { refreshToken: string }
        mcpOAuth: unknown
      }
      expect(after.claudeAiOauth.refreshToken).toBe('fresh')
      expect(after.mcpOAuth).toEqual(mcpBlock)
    })
  })

  test('malformed JSON → overwrite from secrets.json (mcpOAuth lost, but file was unrecoverable)', async () => {
    await withHome((home) => {
      mkdirSync(join(home, '.claude'), { recursive: true })
      writeFileSync(join(home, '.claude', '.credentials.json'), '{ not valid json')
      const result = exportClaudeCredentialsFileIfApplicable({
        claudeCodeEnabled: true,
        providers: oauthProviders({ refresh: 'recovered' }),
        homeDir: home,
      })
      expect(result.action).toBe('wrote')
      const after = JSON.parse(readFileSync(join(home, '.claude', '.credentials.json'), 'utf8')) as {
        claudeAiOauth: { refreshToken: string }
        mcpOAuth?: unknown
      }
      expect(after.claudeAiOauth.refreshToken).toBe('recovered')
      expect(after.mcpOAuth).toBeUndefined()
    })
  })

  test('file present but missing claudeAiOauth.accessToken → overwrite', async () => {
    await withHome((home) => {
      mkdirSync(join(home, '.claude'), { recursive: true })
      writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: {} }))
      const result = exportClaudeCredentialsFileIfApplicable({
        claudeCodeEnabled: true,
        providers: oauthProviders({ refresh: 'oauth-refresh' }),
        homeDir: home,
      })
      expect(result.action).toBe('wrote')
      const after = JSON.parse(readFileSync(join(home, '.claude', '.credentials.json'), 'utf8')) as {
        claudeAiOauth: { refreshToken: string }
      }
      expect(after.claudeAiOauth.refreshToken).toBe('oauth-refresh')
    })
  })

  test('on-disk accessToken has undecodable JWT exp → overwrite', async () => {
    await withHome((home) => {
      mkdirSync(join(home, '.claude'), { recursive: true })
      writeFileSync(
        join(home, '.claude', '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { accessToken: 'not.a.jwt', refreshToken: 'rotten', expiresAt: 0 } }),
      )
      const result = exportClaudeCredentialsFileIfApplicable({
        claudeCodeEnabled: true,
        providers: oauthProviders({ refresh: 'good' }),
        homeDir: home,
      })
      expect(result.action).toBe('wrote')
      const after = JSON.parse(readFileSync(join(home, '.claude', '.credentials.json'), 'utf8')) as {
        claudeAiOauth: { refreshToken: string }
      }
      expect(after.claudeAiOauth.refreshToken).toBe('good')
    })
  })

  test('write failure surfaces as { action: "failed" } and calls the log hook (boot never blocked)', async () => {
    await withHome((home) => {
      mkdirSync(join(home, '.claude', '.credentials.json', 'in-the-way'), { recursive: true })
      const captured: string[] = []
      const result = exportClaudeCredentialsFileIfApplicable({
        claudeCodeEnabled: true,
        providers: oauthProviders({}),
        homeDir: home,
        log: (msg) => captured.push(msg),
      })
      expect(result.action).toBe('failed')
      expect(captured.length).toBe(1)
      expect(captured[0]).toMatch(/^exportClaudeCredentialsFile: /)
    })
  })

  test('credential without `expires` falls back to JWT exp (no spurious overwrite of fresher on-disk file)', async () => {
    await withHome((home) => {
      mkdirSync(join(home, '.claude'), { recursive: true })
      const fresherAccess = makeJwt({ exp: 3_000_000_000 })
      writeFileSync(
        join(home, '.claude', '.credentials.json'),
        JSON.stringify({
          claudeAiOauth: { accessToken: fresherAccess, refreshToken: 'claude-current', expiresAt: 3_000_000_000_000 },
        }),
      )
      const staleCred: Providers = {
        anthropic: {
          type: 'oauth',
          access: makeJwt({ exp: 1_000_000_000 }),
          refresh: 'r',
        } as never,
      }
      const result = exportClaudeCredentialsFileIfApplicable({
        claudeCodeEnabled: true,
        providers: staleCred,
        homeDir: home,
      })
      expect(result).toEqual({ action: 'skipped', reason: 'on-disk-is-fresher' })
    })
  })

  test('credential without expires AND without decodable JWT falls back to now() and writes', async () => {
    await withHome((home) => {
      mkdirSync(join(home, '.claude'), { recursive: true })
      const onDiskAccess = makeJwt({ exp: 1_000_000 })
      writeFileSync(
        join(home, '.claude', '.credentials.json'),
        JSON.stringify({
          claudeAiOauth: { accessToken: onDiskAccess, refreshToken: 'old', expiresAt: 1_000_000_000 },
        }),
      )
      const cred: Providers = {
        anthropic: {
          type: 'oauth',
          access: 'not.decodable',
          refresh: 'r-fallback',
        } as never,
      }
      const result = exportClaudeCredentialsFileIfApplicable({
        claudeCodeEnabled: true,
        providers: cred,
        homeDir: home,
        now: () => 2_000_000_000_000,
      })
      expect(result.action).toBe('wrote')
      const after = JSON.parse(readFileSync(join(home, '.claude', '.credentials.json'), 'utf8')) as {
        claudeAiOauth: { refreshToken: string }
      }
      expect(after.claudeAiOauth.refreshToken).toBe('r-fallback')
    })
  })

  test('preserves the entrypoint shim symlink: writes through the link to the persistent target', async () => {
    await withHome((home) => {
      // given: entrypoint shim has installed a symlink at $HOME/.claude/.credentials.json
      // pointing at the persistent host-side path (mimicking link_persistent_home_files).
      const persistRoot = join(home, 'persist', '.claude')
      mkdirSync(persistRoot, { recursive: true })
      mkdirSync(join(home, '.claude'), { recursive: true })
      const symlinkPath = join(home, '.claude', '.credentials.json')
      const persistPath = join(persistRoot, '.credentials.json')
      symlinkSync(persistPath, symlinkPath)

      // when: exporter fires on first boot (persist target is a dangling symlink).
      const result = exportClaudeCredentialsFileIfApplicable({
        claudeCodeEnabled: true,
        providers: oauthProviders({ refresh: 'first-boot-refresh' }),
        homeDir: home,
      })

      // then: the symlink at $HOME/.claude/.credentials.json must still be a symlink.
      expect(result.action).toBe('wrote')
      expect(lstatSync(symlinkPath).isSymbolicLink()).toBe(true)
      expect(existsSync(persistPath)).toBe(true)
      const onDisk = JSON.parse(readFileSync(persistPath, 'utf8')) as {
        claudeAiOauth: { refreshToken: string }
      }
      expect(onDisk.claudeAiOauth.refreshToken).toBe('first-boot-refresh')
    })
  })

  test('symlink case: newer-wins compare still works because readFileSync follows symlinks', async () => {
    await withHome((home) => {
      // given: symlink in place + persistent file already contains a fresher token.
      const persistRoot = join(home, 'persist', '.claude')
      mkdirSync(persistRoot, { recursive: true })
      mkdirSync(join(home, '.claude'), { recursive: true })
      const symlinkPath = join(home, '.claude', '.credentials.json')
      const persistPath = join(persistRoot, '.credentials.json')
      symlinkSync(persistPath, symlinkPath)
      const fresherAccess = makeJwt({ exp: 3_000_000_000 })
      writeFileSync(
        persistPath,
        JSON.stringify({
          claudeAiOauth: { accessToken: fresherAccess, refreshToken: 'claude-rotated', expiresAt: 3_000_000_000_000 },
        }),
      )

      // when: exporter runs with an older typeclaw-side credential.
      const result = exportClaudeCredentialsFileIfApplicable({
        claudeCodeEnabled: true,
        providers: oauthProviders({ access: makeJwt({ exp: 1_000_000_000 }), expires: 1_000_000_000_000 }),
        homeDir: home,
      })

      // then: skip, because the symlink resolves through to the fresher persistent file.
      expect(result).toEqual({ action: 'skipped', reason: 'on-disk-is-fresher' })
      const after = JSON.parse(readFileSync(persistPath, 'utf8')) as {
        claudeAiOauth: { refreshToken: string }
      }
      expect(after.claudeAiOauth.refreshToken).toBe('claude-rotated')
      expect(lstatSync(symlinkPath).isSymbolicLink()).toBe(true)
    })
  })
})
