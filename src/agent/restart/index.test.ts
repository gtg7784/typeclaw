import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { restartHandoffPath } from '@/agent/restart-handoff'

import { requestContainerRestart } from './index'

let server: ReturnType<typeof Bun.serve> | null = null

const TEST_ACK_TIMEOUT_MS = 30_000

afterEach(() => {
  server?.stop(true)
  server = null
})

describe('requestContainerRestart', () => {
  let agentDir: string

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-request-restart-'))
  })

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true })
  })

  test('uses HTTP transport and returns the accepted restart timestamp', async () => {
    // given
    const requests: Array<{ auth: string | null; body: unknown }> = []
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        requests.push({ auth: req.headers.get('authorization'), body: await req.json() })
        return Response.json({ ok: true, result: { containerName: 'coder', scheduled: true } })
      },
    })

    // when
    const result = await requestContainerRestart({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      hostdToken: 'secret',
      ackTimeoutMs: TEST_ACK_TIMEOUT_MS,
      restartedAt: '2026-01-02T03:04:05.000Z',
    })

    // then
    expect(result).toEqual({ ok: true, containerName: 'coder', restartedAt: '2026-01-02T03:04:05.000Z' })
    expect(requests).toEqual([
      {
        auth: 'Bearer secret',
        body: { kind: 'restart', containerName: 'coder', build: false },
      },
    ])
  })

  test('returns failure without writing a handoff when hostd rejects the restart', async () => {
    // given
    server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ ok: false, reason: 'not registered: coder' })
      },
    })

    // when
    const result = await requestContainerRestart({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      hostdToken: 'secret',
      ackTimeoutMs: TEST_ACK_TIMEOUT_MS,
      agentDir,
      originatingSessionId: 'ses-origin',
      originatingSessionFile: '/tmp/sessions/ses-origin.jsonl',
    })

    // then
    expect(result).toEqual({ ok: false, containerName: 'coder', reason: 'not registered: coder' })
    expect(existsSync(restartHandoffPath(agentDir))).toBe(false)
  })

  test('writes handoff only when every handoff field is present', async () => {
    // given
    server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ ok: true, result: { containerName: 'coder', scheduled: true } })
      },
    })

    // when
    await requestContainerRestart({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      hostdToken: 'secret',
      ackTimeoutMs: TEST_ACK_TIMEOUT_MS,
      agentDir,
      originatingSessionId: 'ses-incomplete',
      restartedAt: '2026-01-02T03:04:05.000Z',
    })
    expect(existsSync(restartHandoffPath(agentDir))).toBe(false)

    const result = await requestContainerRestart({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      hostdToken: 'secret',
      ackTimeoutMs: TEST_ACK_TIMEOUT_MS,
      agentDir,
      originatingSessionId: 'ses-origin',
      originatingSessionFile: '/tmp/sessions/ses-origin.jsonl',
      restartedAt: '2026-01-02T03:04:05.000Z',
    })

    // then
    expect(result).toEqual({ ok: true, containerName: 'coder', restartedAt: '2026-01-02T03:04:05.000Z' })
    expect(JSON.parse(await readFile(restartHandoffPath(agentDir), 'utf8'))).toEqual({
      schemaVersion: 1,
      restartedAt: '2026-01-02T03:04:05.000Z',
      originatingSessionId: 'ses-origin',
      originatingSessionFile: 'ses-origin.jsonl',
    })
  })

  test('forwards build:true in the RPC body', async () => {
    // given
    const requests: unknown[] = []
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        requests.push(await req.json())
        return Response.json({ ok: true, result: { containerName: 'coder', scheduled: true } })
      },
    })

    // when
    await requestContainerRestart({
      containerName: 'coder',
      build: true,
      hostdUrl: `http://127.0.0.1:${server.port}`,
      hostdToken: 'secret',
      ackTimeoutMs: TEST_ACK_TIMEOUT_MS,
    })

    // then
    expect(requests).toEqual([{ kind: 'restart', containerName: 'coder', build: true }])
  })
})
