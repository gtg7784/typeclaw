import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { restartHandoffPath } from '@/agent/restart-handoff'
import { createStream, type StreamMessage } from '@/stream'

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

    // when: originatingSessionFile missing → no handoff
    await requestContainerRestart({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      hostdToken: 'secret',
      ackTimeoutMs: TEST_ACK_TIMEOUT_MS,
      agentDir,
      originatingSessionId: 'ses-incomplete',
      handoffOrigin: { kind: 'tui' },
      restartedAt: '2026-01-02T03:04:05.000Z',
    })
    expect(existsSync(restartHandoffPath(agentDir))).toBe(false)

    // when: handoffOrigin missing → no handoff
    await requestContainerRestart({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      hostdToken: 'secret',
      ackTimeoutMs: TEST_ACK_TIMEOUT_MS,
      agentDir,
      originatingSessionId: 'ses-no-origin',
      originatingSessionFile: '/tmp/sessions/ses-no-origin.jsonl',
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
      handoffOrigin: { kind: 'tui' },
      restartedAt: '2026-01-02T03:04:05.000Z',
    })

    // then
    expect(result).toEqual({ ok: true, containerName: 'coder', restartedAt: '2026-01-02T03:04:05.000Z' })
    expect(JSON.parse(await readFile(restartHandoffPath(agentDir), 'utf8'))).toEqual({
      schemaVersion: 2,
      restartedAt: '2026-01-02T03:04:05.000Z',
      originatingSessionId: 'ses-origin',
      originatingSessionFile: 'ses-origin.jsonl',
      origin: { kind: 'tui' },
    })
  })

  test('publishes a container-restarting broadcast before writing the handoff on a successful ACK', async () => {
    // given: a stream whose subscriber records broadcasts, and a hostd that
    // accepts. The broadcast must carry the originating session id so the
    // matching session's subscribeRestartNotice can append restart-self.
    server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ ok: true, result: { containerName: 'coder', scheduled: true } })
      },
    })
    const stream = createStream()
    const received: StreamMessage[] = []
    stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => received.push(msg))

    // when
    await requestContainerRestart({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      hostdToken: 'secret',
      ackTimeoutMs: TEST_ACK_TIMEOUT_MS,
      stream,
      agentDir,
      originatingSessionId: 'ses-origin',
      originatingSessionFile: '/tmp/sessions/ses-origin.jsonl',
      restartedAt: '2026-01-02T03:04:05.000Z',
    })

    // then
    expect(received).toHaveLength(1)
    expect(received[0]?.payload).toEqual({
      kind: 'container-restarting',
      restartedAt: '2026-01-02T03:04:05.000Z',
      originatingSessionId: 'ses-origin',
    })
  })

  test('does not publish a broadcast when hostd rejects the restart', async () => {
    // given
    server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ ok: false, reason: 'not registered: coder' })
      },
    })
    const stream = createStream()
    const received: StreamMessage[] = []
    stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => received.push(msg))

    // when
    const result = await requestContainerRestart({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      hostdToken: 'secret',
      ackTimeoutMs: TEST_ACK_TIMEOUT_MS,
      stream,
      originatingSessionId: 'ses-origin',
    })

    // then
    expect(result.ok).toBe(false)
    expect(received).toHaveLength(0)
  })

  test('still succeeds when the handoff write fails after hostd accepts', async () => {
    // given: hostd has accepted, but the handoff target is unwritable because a
    // regular file occupies the agent dir, so mkdir of `.typeclaw` will throw
    server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ ok: true, result: { containerName: 'coder', scheduled: true } })
      },
    })
    const fileAsAgentDir = join(agentDir, 'not-a-dir')
    await writeFile(fileAsAgentDir, 'x', 'utf8')

    // when
    const result = await requestContainerRestart({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      hostdToken: 'secret',
      ackTimeoutMs: TEST_ACK_TIMEOUT_MS,
      agentDir: fileAsAgentDir,
      originatingSessionId: 'ses-origin',
      originatingSessionFile: '/tmp/sessions/ses-origin.jsonl',
      restartedAt: '2026-01-02T03:04:05.000Z',
    })

    // then: the already-committed restart is not demoted to a failure
    expect(result).toEqual({ ok: true, containerName: 'coder', restartedAt: '2026-01-02T03:04:05.000Z' })
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
