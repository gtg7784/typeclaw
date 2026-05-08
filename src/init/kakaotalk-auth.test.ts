import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { kakaotalkConfigDir, runKakaotalkBootstrap, type SpawnLoginArgs, type SpawnLoginResult } from './kakaotalk-auth'

describe('kakaotalkConfigDir', () => {
  test('places credentials under the agent workspace, not the user home', () => {
    const dir = kakaotalkConfigDir('/foo/agent')
    expect(dir).toBe('/foo/agent/workspace/.agent-messenger')
  })
})

describe('runKakaotalkBootstrap', () => {
  const tmp = async (): Promise<string> => mkdtemp(join(tmpdir(), 'typeclaw-kakao-test-'))

  test('returns ok when the spawned login reports authenticated:true', async () => {
    const agentDir = await tmp()
    try {
      const fake = async (args: SpawnLoginArgs): Promise<SpawnLoginResult> => {
        expect(args.configDir).toBe(join(agentDir, 'workspace', '.agent-messenger'))
        expect(args.email).toBe('user@example.com')
        return {
          exitCode: 0,
          stdout: JSON.stringify({ authenticated: true, account_id: 'a1', user_id: 'u1' }) + '\n',
          stderr: '',
        }
      }
      const result = await runKakaotalkBootstrap({
        email: 'user@example.com',
        password: 'secret',
        agentDir,
        callbacks: { onPasscode: () => {} },
        spawnLogin: fake,
      })
      expect(result).toEqual({ ok: true })
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('returns failure with the CLI-reported message when authenticated:false', async () => {
    const agentDir = await tmp()
    try {
      const fake = async (): Promise<SpawnLoginResult> => ({
        exitCode: 0,
        stdout:
          JSON.stringify({
            authenticated: false,
            error: 'bad_credentials',
            message: 'Login failed: incorrect email or password.',
          }) + '\n',
        stderr: '',
      })
      const result = await runKakaotalkBootstrap({
        email: 'user@example.com',
        password: 'wrong',
        agentDir,
        callbacks: { onPasscode: () => {} },
        spawnLogin: fake,
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toBe('Login failed: incorrect email or password.')
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('returns failure when the spawned process exits non-zero', async () => {
    const agentDir = await tmp()
    try {
      const fake = async (): Promise<SpawnLoginResult> => ({
        exitCode: 2,
        stdout: '',
        stderr: 'agent-kakaotalk: command not found',
      })
      const result = await runKakaotalkBootstrap({
        email: 'user@example.com',
        password: 'x',
        agentDir,
        callbacks: { onPasscode: () => {} },
        spawnLogin: fake,
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toContain('agent-kakaotalk: command not found')
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('returns failure when stdout has no JSON', async () => {
    const agentDir = await tmp()
    try {
      const fake = async (): Promise<SpawnLoginResult> => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
      })
      const result = await runKakaotalkBootstrap({
        email: 'u@e.com',
        password: 'x',
        agentDir,
        callbacks: { onPasscode: () => {} },
        spawnLogin: fake,
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toContain('no JSON output')
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('passes the password file path to the spawn fn (and only the path, not the password)', async () => {
    const agentDir = await tmp()
    try {
      let receivedPath: string | null = null
      const fake = async (args: SpawnLoginArgs): Promise<SpawnLoginResult> => {
        receivedPath = args.passwordFile
        return { exitCode: 0, stdout: JSON.stringify({ authenticated: true }), stderr: '' }
      }
      await runKakaotalkBootstrap({
        email: 'u@e.com',
        password: 'super-secret',
        agentDir,
        callbacks: { onPasscode: () => {} },
        spawnLogin: fake,
      })
      expect(receivedPath).not.toBeNull()
      expect(receivedPath!).toMatch(/typeclaw-kakao-/)
      expect(receivedPath!).not.toContain('super-secret')
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('does not mutate process.env.AGENT_MESSENGER_CONFIG_DIR', async () => {
    const before = process.env.AGENT_MESSENGER_CONFIG_DIR
    const agentDir = await tmp()
    try {
      await runKakaotalkBootstrap({
        email: 'u@e.com',
        password: 'x',
        agentDir,
        callbacks: { onPasscode: () => {} },
        spawnLogin: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({ authenticated: true }),
          stderr: '',
        }),
      })
      expect(process.env.AGENT_MESSENGER_CONFIG_DIR).toBe(before)
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })
})
