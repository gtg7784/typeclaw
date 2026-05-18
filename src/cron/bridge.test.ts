import { afterEach, describe, expect, test } from 'bun:test'

import type { Server } from 'bun'

import type { ClientMessage, CronListEntryPayload, ServerMessage } from '@/shared'

import { fetchCronList } from './bridge'

let server: Server<undefined> | null = null

afterEach(() => {
  server?.stop(true)
  server = null
})

function startFakeAgent(reply: (msg: ClientMessage) => ServerMessage | null): number {
  const bun = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return
      return new Response('not a ws', { status: 400 })
    },
    websocket: {
      message(ws, raw) {
        const msg = JSON.parse(String(raw)) as ClientMessage
        const out = reply(msg)
        if (out !== null) ws.send(JSON.stringify(out))
      },
    },
  })
  server = bun
  if (bun.port === undefined) throw new Error('Bun.serve returned no port')
  return bun.port
}

describe('cron list bridge', () => {
  test('redacts tokenized URLs in connection errors', async () => {
    const result = await fetchCronList({
      cwd: process.cwd(),
      url: 'ws://localhost:1?token=secret-token',
      timeoutMs: 200,
    })

    expect(result.kind).toBe('unreachable')
    if (result.kind !== 'unreachable') throw new Error('expected unreachable result')
    expect(result.reason).toContain('token=%3Credacted%3E')
    expect(result.reason).not.toContain('secret-token')
  })

  test('returns unreachable when the host is not listening', async () => {
    const result = await fetchCronList({
      cwd: process.cwd(),
      url: 'ws://127.0.0.1:1',
      timeoutMs: 500,
    })
    expect(result.kind).toBe('unreachable')
  })

  test('parses a successful cron_list_result reply', async () => {
    const job: CronListEntryPayload = {
      id: 'job-1',
      source: { kind: 'user' },
      kind: 'prompt',
      schedule: '*/5 * * * *',
      enabled: true,
      nextFireMs: 1_000_000,
      prompt: 'hi',
    }
    const port = startFakeAgent((msg) => {
      if (msg.type !== 'cron_list') return null
      return { type: 'cron_list_result', requestId: msg.requestId, result: { ok: true, jobs: [job], nowMs: 999_500 } }
    })

    const result = await fetchCronList({ cwd: process.cwd(), url: `ws://127.0.0.1:${port}`, timeoutMs: 2000 })
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('unreachable')
    expect(result.jobs).toEqual([job])
    expect(result.nowMs).toBe(999_500)
  })

  test('maps server-side ok:false into bridge error result', async () => {
    const port = startFakeAgent((msg) => {
      if (msg.type !== 'cron_list') return null
      return { type: 'cron_list_result', requestId: msg.requestId, result: { ok: false, reason: 'bad cron.json' } }
    })

    const result = await fetchCronList({ cwd: process.cwd(), url: `ws://127.0.0.1:${port}`, timeoutMs: 2000 })
    expect(result.kind).toBe('error')
    if (result.kind !== 'error') throw new Error('unreachable')
    expect(result.reason).toBe('bad cron.json')
  })

  test('ignores replies whose requestId does not match', async () => {
    const port = startFakeAgent((msg) => {
      if (msg.type !== 'cron_list') return null
      return { type: 'cron_list_result', requestId: 'wrong-id', result: { ok: true, jobs: [], nowMs: 0 } }
    })

    const result = await fetchCronList({ cwd: process.cwd(), url: `ws://127.0.0.1:${port}`, timeoutMs: 300 })
    expect(result.kind).toBe('timeout')
  })
})
