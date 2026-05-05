import { afterEach, describe, expect, test } from 'bun:test'

import { createStream, type StreamMessage } from '@/stream'

import { createRestartTool } from './restart'

let server: ReturnType<typeof Bun.serve> | null = null
const fakeCtx = {} as Parameters<ReturnType<typeof createRestartTool>['execute']>[4]

afterEach(() => {
  server?.stop(true)
  server = null
})

function startOkServer(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    fetch() {
      return Response.json({ ok: true, result: { containerName: 'coder', scheduled: true } })
    },
  })
}

describe('createRestartTool', () => {
  test('uses HTTP hostd transport when URL and token are configured', async () => {
    const requests: Array<{ auth: string | null; body: unknown }> = []
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        requests.push({ auth: req.headers.get('authorization'), body: await req.json() })
        return Response.json({ ok: true, result: { containerName: 'coder', scheduled: true } })
      },
    })
    let exitCode: number | undefined
    const tool = createRestartTool({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      hostdToken: 'secret',
      originatingSessionId: 'ses-test-origin',
      exit: (code) => {
        exitCode = code
      },
    })

    const result = await tool.execute('id', {}, undefined, undefined, fakeCtx)

    expect(result.details).toEqual({ ok: true, containerName: 'coder' })
    expect(requests).toEqual([
      {
        auth: 'Bearer secret',
        body: { kind: 'restart', containerName: 'coder', build: false },
      },
    ])
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(exitCode).toBe(0)
  })

  test('forwards build:true in the RPC body when invoked with { build: true }', async () => {
    const requests: Array<{ body: unknown }> = []
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        requests.push({ body: await req.json() })
        return Response.json({ ok: true, result: { containerName: 'coder', scheduled: true } })
      },
    })
    const tool = createRestartTool({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      hostdToken: 'secret',
      originatingSessionId: 'ses-test-origin',
      exit: () => {},
    })

    const result = await tool.execute('id', { build: true }, undefined, undefined, fakeCtx)

    expect(result.details).toEqual({ ok: true, containerName: 'coder' })
    expect(requests).toEqual([{ body: { kind: 'restart', containerName: 'coder', build: true } }])
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('image rebuild') })
  })

  test('omitting build defaults to build:false in the RPC body', async () => {
    const requests: Array<{ body: unknown }> = []
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        requests.push({ body: await req.json() })
        return Response.json({ ok: true, result: { containerName: 'coder', scheduled: true } })
      },
    })
    const tool = createRestartTool({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      hostdToken: 'secret',
      originatingSessionId: 'ses-test-origin',
      exit: () => {},
    })

    const result = await tool.execute('id', {}, undefined, undefined, fakeCtx)

    expect(requests).toEqual([{ body: { kind: 'restart', containerName: 'coder', build: false } }])
    expect(result.content[0]).toMatchObject({ text: expect.not.stringContaining('image rebuild') })
  })

  test('returns denial details when HTTP restart is rejected', async () => {
    server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ ok: false, reason: 'invalid restart token' })
      },
    })
    const tool = createRestartTool({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      hostdToken: 'bad',
      originatingSessionId: 'ses-test-origin',
      exit: () => {
        throw new Error('exit should not run')
      },
    })

    const result = await tool.execute('id', {}, undefined, undefined, fakeCtx)

    expect(result.details).toEqual({ ok: false, containerName: 'coder', reason: 'invalid restart token' })
  })

  test('publishes a container-restarting broadcast on successful ACK', async () => {
    // given
    server = startOkServer()
    const stream = createStream()
    const received: StreamMessage[] = []
    stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => {
      received.push(msg)
    })
    const tool = createRestartTool({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      hostdToken: 'secret',
      originatingSessionId: 'ses-test-origin',
      exit: () => {},
      stream,
    })

    // when
    await tool.execute('id', {}, undefined, undefined, fakeCtx)

    // then
    expect(received).toHaveLength(1)
    const payload = received[0]?.payload as { kind: string; restartedAt: string }
    expect(payload.kind).toBe('container-restarting')
    expect(typeof payload.restartedAt).toBe('string')
    expect(() => new Date(payload.restartedAt).toISOString()).not.toThrow()
    expect(new Date(payload.restartedAt).toISOString()).toBe(payload.restartedAt)
  })

  test('broadcast carries the originatingSessionId passed at construction', async () => {
    // given
    server = startOkServer()
    const stream = createStream()
    const received: StreamMessage[] = []
    stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => {
      received.push(msg)
    })
    const tool = createRestartTool({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      hostdToken: 'secret',
      originatingSessionId: 'ses-the-one-that-asked',
      exit: () => {},
      stream,
    })

    // when
    await tool.execute('id', {}, undefined, undefined, fakeCtx)

    // then
    expect(received).toHaveLength(1)
    const payload = received[0]?.payload as { originatingSessionId: string }
    expect(payload.originatingSessionId).toBe('ses-the-one-that-asked')
  })

  test('does not publish a broadcast when hostd denies the restart', async () => {
    // given
    server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ ok: false, reason: 'denied' })
      },
    })
    const stream = createStream()
    const received: StreamMessage[] = []
    stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => {
      received.push(msg)
    })
    const tool = createRestartTool({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      hostdToken: 'bad',
      originatingSessionId: 'ses-test-origin',
      exit: () => {
        throw new Error('exit should not run')
      },
      stream,
    })

    // when
    await tool.execute('id', {}, undefined, undefined, fakeCtx)

    // then
    expect(received).toHaveLength(0)
  })

  test('completes successfully when stream is omitted (back-compat for non-runtime callers)', async () => {
    // given
    server = startOkServer()
    let exitCode: number | undefined
    const tool = createRestartTool({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      hostdToken: 'secret',
      originatingSessionId: 'ses-test-origin',
      exit: (code) => {
        exitCode = code
      },
    })

    // when
    const result = await tool.execute('id', {}, undefined, undefined, fakeCtx)

    // then
    expect(result.details).toEqual({ ok: true, containerName: 'coder' })
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(exitCode).toBe(0)
  })
})
