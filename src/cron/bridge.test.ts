import { afterEach, describe, expect, test } from 'bun:test'

import type { Server } from 'bun'

import { CONTAINER_PORT } from '@/container'
import type { ClientMessage, CronListEntryPayload, ServerMessage } from '@/shared'

import { fetchCronList, resolveInContainerUrl } from './bridge'

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

// Generous bound for happy-path WS round-trips under parallel-test
// contention. Tests that deliberately exercise the timeout path (e.g.
// "ignores replies whose requestId does not match") still use a tight
// bound — those tests' contract IS the timeout, and bumping them would
// just make the suite slower without making it more reliable.
const HAPPY_PATH_TIMEOUT_MS = 10_000

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

    const result = await fetchCronList({
      cwd: process.cwd(),
      url: `ws://127.0.0.1:${port}`,
      timeoutMs: HAPPY_PATH_TIMEOUT_MS,
    })
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

    const result = await fetchCronList({
      cwd: process.cwd(),
      url: `ws://127.0.0.1:${port}`,
      timeoutMs: HAPPY_PATH_TIMEOUT_MS,
    })
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

describe('resolveInContainerUrl', () => {
  test('returns null when TYPECLAW_CONTAINER_NAME is unset (host stage)', () => {
    expect(resolveInContainerUrl({})).toBeNull()
    expect(resolveInContainerUrl({ TYPECLAW_TUI_TOKEN: 'tok' })).toBeNull()
  })

  test('builds a loopback URL on CONTAINER_PORT when running inside the container', () => {
    const url = resolveInContainerUrl({ TYPECLAW_CONTAINER_NAME: 'agent', TYPECLAW_TUI_TOKEN: 'tok' })
    expect(url).toBe(`ws://127.0.0.1:${CONTAINER_PORT}/?token=tok`)
  })

  test('omits the token query when TYPECLAW_TUI_TOKEN is unset or empty', () => {
    expect(resolveInContainerUrl({ TYPECLAW_CONTAINER_NAME: 'agent' })).toBe(`ws://127.0.0.1:${CONTAINER_PORT}/`)
    expect(resolveInContainerUrl({ TYPECLAW_CONTAINER_NAME: 'agent', TYPECLAW_TUI_TOKEN: '' })).toBe(
      `ws://127.0.0.1:${CONTAINER_PORT}/`,
    )
  })
})

describe('fetchCronList in-container path', () => {
  test('uses the env-derived in-container URL when no --url is given', async () => {
    // The mutation check: if dial() ignored the injected env and fell
    // back to resolveHostPort (the broken pre-fix behavior), it would
    // try to shell out to docker — which on this host returns the
    // configured port from typeclaw.json, NOT 127.0.0.1:CONTAINER_PORT.
    // We can't bind on CONTAINER_PORT in test (collisions), so we assert
    // that an in-container `fetchCronList` call dials CONTAINER_PORT
    // specifically by inspecting the unreachable error.
    const result = await fetchCronList({
      cwd: process.cwd(),
      timeoutMs: 200,
      env: { TYPECLAW_CONTAINER_NAME: 'agent', TYPECLAW_TUI_TOKEN: 'secret-token-value' },
    })
    expect(result.kind).toBe('unreachable')
    if (result.kind !== 'unreachable') throw new Error('expected unreachable result')
    expect(result.reason).toContain(`127.0.0.1:${CONTAINER_PORT}`)
    expect(result.reason).toContain('token=%3Credacted%3E')
    expect(result.reason).not.toContain('secret-token-value')
  })

  test('explicit --url wins over the env-derived in-container URL', async () => {
    const port = startFakeAgent((msg) => {
      if (msg.type !== 'cron_list') return null
      return { type: 'cron_list_result', requestId: msg.requestId, result: { ok: true, jobs: [], nowMs: 0 } }
    })

    const result = await fetchCronList({
      cwd: process.cwd(),
      url: `ws://127.0.0.1:${port}`,
      timeoutMs: HAPPY_PATH_TIMEOUT_MS,
      env: { TYPECLAW_CONTAINER_NAME: 'agent', TYPECLAW_TUI_TOKEN: 'tok' },
    })
    expect(result.kind).toBe('ok')
  })
})
