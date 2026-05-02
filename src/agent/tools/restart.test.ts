import { afterEach, describe, expect, test } from 'bun:test'

import { createRestartTool } from './restart'

let server: ReturnType<typeof Bun.serve> | null = null
const fakeCtx = {} as Parameters<ReturnType<typeof createRestartTool>['execute']>[4]

afterEach(() => {
  server?.stop(true)
  server = null
})

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
      exit: (code) => {
        exitCode = code
      },
    })

    const result = await tool.execute('id', {}, undefined, undefined, fakeCtx)

    expect(result.details).toEqual({ ok: true, containerName: 'coder' })
    expect(requests).toEqual([
      {
        auth: 'Bearer secret',
        body: { kind: 'restart', containerName: 'coder' },
      },
    ])
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(exitCode).toBe(0)
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
      exit: () => {
        throw new Error('exit should not run')
      },
    })

    const result = await tool.execute('id', {}, undefined, undefined, fakeCtx)

    expect(result.details).toEqual({ ok: false, containerName: 'coder', reason: 'invalid restart token' })
  })
})
