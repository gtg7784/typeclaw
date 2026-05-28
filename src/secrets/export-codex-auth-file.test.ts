import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { exportCodexAuthFileIfApplicable } from './export-codex-auth-file'
import type { Providers } from './schema'

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.sig`
}

function oauthProviders(opts: { access?: string; refresh?: string; expires?: number; accountId?: string }): Providers {
  return {
    'openai-codex': {
      type: 'oauth',
      access: opts.access ?? makeJwt({ exp: 2_000_000_000 }),
      refresh: opts.refresh ?? 'refresh-token',
      expires: opts.expires ?? 2_000_000_000_000,
      ...(opts.accountId !== undefined ? { accountId: opts.accountId } : {}),
    } as never,
  }
}

async function withHome<T>(fn: (home: string) => Promise<T> | T): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'typeclaw-codex-export-'))
  try {
    return await fn(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

describe('exportCodexAuthFileIfApplicable', () => {
  test('B4: codexCli disabled → skip without touching the filesystem', async () => {
    await withHome((home) => {
      const result = exportCodexAuthFileIfApplicable({
        codexCliEnabled: false,
        providers: oauthProviders({}),
        homeDir: home,
      })
      expect(result).toEqual({ action: 'skipped', reason: 'codex-cli-disabled' })
      expect(existsSync(join(home, '.codex'))).toBe(false)
    })
  })

  test('B5: openai-codex provider absent → skip', async () => {
    await withHome((home) => {
      const result = exportCodexAuthFileIfApplicable({
        codexCliEnabled: true,
        providers: {},
        homeDir: home,
      })
      expect(result).toEqual({ action: 'skipped', reason: 'no-openai-codex-credential' })
      expect(existsSync(join(home, '.codex'))).toBe(false)
    })
  })

  test('skips when openai-codex credential is api-key shape (defensive)', async () => {
    await withHome((home) => {
      const providers: Providers = {
        'openai-codex': { type: 'api_key', key: { value: 'sk-x' } } as never,
      }
      const result = exportCodexAuthFileIfApplicable({
        codexCliEnabled: true,
        providers,
        homeDir: home,
      })
      expect(result).toEqual({ action: 'skipped', reason: 'credential-not-oauth' })
      expect(existsSync(join(home, '.codex'))).toBe(false)
    })
  })

  test('B1: no auth.json yet → writes from secrets.json', async () => {
    await withHome((home) => {
      const result = exportCodexAuthFileIfApplicable({
        codexCliEnabled: true,
        providers: oauthProviders({ access: 'access-1', refresh: 'refresh-1', accountId: 'acct-1' }),
        homeDir: home,
      })
      expect(result.action).toBe('wrote')
      const target = join(home, '.codex', 'auth.json')
      expect(existsSync(target)).toBe(true)
      const parsed = JSON.parse(readFileSync(target, 'utf8')) as {
        tokens: { access_token: string; refresh_token: string; account_id?: string }
      }
      expect(parsed.tokens).toEqual({ access_token: 'access-1', refresh_token: 'refresh-1', account_id: 'acct-1' })
    })
  })

  test('B1: writes with 0600 file mode (refresh token is long-lived)', async () => {
    await withHome((home) => {
      exportCodexAuthFileIfApplicable({
        codexCliEnabled: true,
        providers: oauthProviders({}),
        homeDir: home,
      })
      const stat = statSync(join(home, '.codex', 'auth.json'))
      expect(stat.mode & 0o777).toBe(0o600)
    })
  })

  test('B2: existing auth.json with strictly later JWT exp → skip (codex CLI refreshed in-place)', async () => {
    await withHome((home) => {
      mkdirSync(join(home, '.codex'), { recursive: true })
      const freshAccess = makeJwt({ exp: 3_000_000_000 })
      writeFileSync(
        join(home, '.codex', 'auth.json'),
        JSON.stringify({ tokens: { access_token: freshAccess, refresh_token: 'codex-refreshed' } }),
      )
      const result = exportCodexAuthFileIfApplicable({
        codexCliEnabled: true,
        providers: oauthProviders({
          access: makeJwt({ exp: 1_000_000_000 }),
          expires: 1_000_000_000_000,
        }),
        homeDir: home,
      })
      expect(result).toEqual({ action: 'skipped', reason: 'on-disk-is-fresher' })
      const after = JSON.parse(readFileSync(join(home, '.codex', 'auth.json'), 'utf8')) as {
        tokens: { refresh_token: string }
      }
      expect(after.tokens.refresh_token).toBe('codex-refreshed')
    })
  })

  test('B3: existing auth.json with older JWT exp → overwrite (user re-pasted via wizard)', async () => {
    await withHome((home) => {
      mkdirSync(join(home, '.codex'), { recursive: true })
      const staleAccess = makeJwt({ exp: 1_000_000_000 })
      writeFileSync(
        join(home, '.codex', 'auth.json'),
        JSON.stringify({ tokens: { access_token: staleAccess, refresh_token: 'stale-refresh' } }),
      )
      const result = exportCodexAuthFileIfApplicable({
        codexCliEnabled: true,
        providers: oauthProviders({
          access: makeJwt({ exp: 3_000_000_000 }),
          refresh: 'fresh-refresh',
          expires: 3_000_000_000_000,
        }),
        homeDir: home,
      })
      expect(result.action).toBe('wrote')
      const after = JSON.parse(readFileSync(join(home, '.codex', 'auth.json'), 'utf8')) as {
        tokens: { refresh_token: string }
      }
      expect(after.tokens.refresh_token).toBe('fresh-refresh')
    })
  })

  test('tie on JWT exp → skip (steady state at zero churn)', async () => {
    await withHome((home) => {
      mkdirSync(join(home, '.codex'), { recursive: true })
      const tied = makeJwt({ exp: 2_000_000_000 })
      writeFileSync(
        join(home, '.codex', 'auth.json'),
        JSON.stringify({ tokens: { access_token: tied, refresh_token: 'on-disk' } }),
      )
      const result = exportCodexAuthFileIfApplicable({
        codexCliEnabled: true,
        providers: oauthProviders({ access: tied, refresh: 'in-secrets', expires: 2_000_000_000_000 }),
        homeDir: home,
      })
      expect(result).toEqual({ action: 'skipped', reason: 'on-disk-is-fresher' })
      const after = JSON.parse(readFileSync(join(home, '.codex', 'auth.json'), 'utf8')) as {
        tokens: { refresh_token: string }
      }
      expect(after.tokens.refresh_token).toBe('on-disk')
    })
  })

  test('B6: existing auth.json is malformed JSON → overwrite from secrets.json', async () => {
    await withHome((home) => {
      mkdirSync(join(home, '.codex'), { recursive: true })
      writeFileSync(join(home, '.codex', 'auth.json'), '{ not valid json')
      const result = exportCodexAuthFileIfApplicable({
        codexCliEnabled: true,
        providers: oauthProviders({ refresh: 'recovered' }),
        homeDir: home,
      })
      expect(result.action).toBe('wrote')
      const after = JSON.parse(readFileSync(join(home, '.codex', 'auth.json'), 'utf8')) as {
        tokens: { refresh_token: string }
      }
      expect(after.tokens.refresh_token).toBe('recovered')
    })
  })

  test('B6 variant: auth.json missing the tokens.access_token field → overwrite', async () => {
    await withHome((home) => {
      mkdirSync(join(home, '.codex'), { recursive: true })
      writeFileSync(join(home, '.codex', 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-stale' }))
      const result = exportCodexAuthFileIfApplicable({
        codexCliEnabled: true,
        providers: oauthProviders({ refresh: 'oauth-refresh' }),
        homeDir: home,
      })
      expect(result.action).toBe('wrote')
      const after = JSON.parse(readFileSync(join(home, '.codex', 'auth.json'), 'utf8')) as {
        tokens: { refresh_token: string }
      }
      expect(after.tokens.refresh_token).toBe('oauth-refresh')
    })
  })

  test('B6 variant: on-disk access_token has undecodable JWT exp → overwrite', async () => {
    await withHome((home) => {
      mkdirSync(join(home, '.codex'), { recursive: true })
      writeFileSync(
        join(home, '.codex', 'auth.json'),
        JSON.stringify({ tokens: { access_token: 'not.a.jwt', refresh_token: 'rotten' } }),
      )
      const result = exportCodexAuthFileIfApplicable({
        codexCliEnabled: true,
        providers: oauthProviders({ refresh: 'good' }),
        homeDir: home,
      })
      expect(result.action).toBe('wrote')
      const after = JSON.parse(readFileSync(join(home, '.codex', 'auth.json'), 'utf8')) as {
        tokens: { refresh_token: string }
      }
      expect(after.tokens.refresh_token).toBe('good')
    })
  })

  test('B7: write failure surfaces as { action: "failed" } and calls the log hook (boot never blocked)', async () => {
    await withHome((home) => {
      // Pre-create a non-writable file at the target path. mkdirSync inside
      // writeAtomic still succeeds because the parent dir exists; the
      // writeFileSync for the temp file inherits FILE_MODE which we can
      // observe, but the rename target file being read-only doesn't matter
      // — renameSync overwrites regardless of target mode on POSIX. So
      // instead, pre-create a DIRECTORY at the target path: renameSync from
      // a file to a path that's a non-empty directory fails on Linux/macOS.
      mkdirSync(join(home, '.codex', 'auth.json', 'in-the-way'), { recursive: true })
      const captured: string[] = []
      const result = exportCodexAuthFileIfApplicable({
        codexCliEnabled: true,
        providers: oauthProviders({}),
        homeDir: home,
        log: (msg) => captured.push(msg),
      })
      expect(result.action).toBe('failed')
      expect(captured.length).toBe(1)
      expect(captured[0]).toMatch(/^exportCodexAuthFile: /)
    })
  })

  test('credential without `expires` falls back to JWT exp (no spurious overwrite of fresher on-disk file)', async () => {
    await withHome((home) => {
      mkdirSync(join(home, '.codex'), { recursive: true })
      const fresherAccess = makeJwt({ exp: 3_000_000_000 })
      writeFileSync(
        join(home, '.codex', 'auth.json'),
        JSON.stringify({ tokens: { access_token: fresherAccess, refresh_token: 'codex-current' } }),
      )
      const staleCred: Providers = {
        'openai-codex': {
          type: 'oauth',
          access: makeJwt({ exp: 1_000_000_000 }),
          refresh: 'r',
        } as never,
      }
      const result = exportCodexAuthFileIfApplicable({
        codexCliEnabled: true,
        providers: staleCred,
        homeDir: home,
      })
      expect(result).toEqual({ action: 'skipped', reason: 'on-disk-is-fresher' })
    })
  })

  test('credential without expires AND without decodable JWT falls back to now() and writes', async () => {
    await withHome((home) => {
      mkdirSync(join(home, '.codex'), { recursive: true })
      const onDiskAccess = makeJwt({ exp: 1_000_000 })
      writeFileSync(
        join(home, '.codex', 'auth.json'),
        JSON.stringify({ tokens: { access_token: onDiskAccess, refresh_token: 'old' } }),
      )
      const cred: Providers = {
        'openai-codex': {
          type: 'oauth',
          access: 'not.decodable',
          refresh: 'r-fallback',
        } as never,
      }
      const result = exportCodexAuthFileIfApplicable({
        codexCliEnabled: true,
        providers: cred,
        homeDir: home,
        now: () => 2_000_000_000_000,
      })
      expect(result.action).toBe('wrote')
      const after = JSON.parse(readFileSync(join(home, '.codex', 'auth.json'), 'utf8')) as {
        tokens: { refresh_token: string }
      }
      expect(after.tokens.refresh_token).toBe('r-fallback')
    })
  })
})
