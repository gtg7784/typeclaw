import { describe, expect, test } from 'bun:test'

import type { ClientMessage, ServerMessage } from '@/shared'

import { proxyContainerCommand, type WebSocketLike } from './container-command-client'

type Listener = (event: { data?: unknown; code?: number; reason?: string; message?: string }) => void

type FakeServerBehavior = {
  onMessage?: (msg: ClientMessage, send: (m: ServerMessage) => void, close: () => void) => void
}

function makeFakeWs(behavior: FakeServerBehavior): { factory: (url: string) => WebSocketLike; sent: ClientMessage[] } {
  const sent: ClientMessage[] = []
  const factory = (_url: string): WebSocketLike => {
    const openListeners: Listener[] = []
    const messageListeners: Listener[] = []
    const closeListeners: Listener[] = []
    let closed = false

    const send = (m: ServerMessage) => {
      if (closed) return
      for (const l of messageListeners) l({ data: JSON.stringify(m) })
    }
    const close = () => {
      if (closed) return
      closed = true
      for (const l of closeListeners) l({})
    }

    queueMicrotask(() => {
      for (const l of openListeners) l({})
    })

    return {
      send(data) {
        if (closed) return
        const msg = JSON.parse(data) as ClientMessage
        sent.push(msg)
        behavior.onMessage?.(msg, send, close)
      },
      close() {
        close()
      },
      addEventListener(event, listener) {
        if (event === 'open') openListeners.push(listener)
        else if (event === 'message') messageListeners.push(listener)
        else if (event === 'close') closeListeners.push(listener)
      },
    }
  }
  return { factory, sent }
}

function captureStream(): { writable: WritableStream<Uint8Array>; read: () => string } {
  const chunks: Uint8Array[] = []
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk)
    },
  })
  const read = () => {
    const total = chunks.reduce((acc, c) => acc + c.length, 0)
    const merged = new Uint8Array(total)
    let off = 0
    for (const c of chunks) {
      merged.set(c, off)
      off += c.length
    }
    return new TextDecoder().decode(merged)
  }
  return { writable, read }
}

const fakeResolveUrl = async () => ({ url: 'ws://fake' })

describe('proxyContainerCommand', () => {
  test('QA-C10: forwards command_stdout to local stdout writable', async () => {
    const { factory } = makeFakeWs({
      onMessage(msg, send) {
        if (msg.type === 'exec_command') {
          send({ type: 'command_stdout', callId: msg.callId, chunk: btoa('hello world') })
          send({ type: 'command_exit', callId: msg.callId, code: 0 })
        }
      },
    })
    const out = captureStream()
    const result = await proxyContainerCommand({
      agentDir: '/tmp/agent',
      commandName: 'echo',
      args: {},
      stdout: out.writable,
      resolveUrl: fakeResolveUrl,
      websocketFactory: factory,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.exitCode).toBe(0)
    expect(out.read()).toBe('hello world')
  })

  test('QA-C11: command_exit { code: 7 } resolves with exitCode 7', async () => {
    const { factory } = makeFakeWs({
      onMessage(msg, send) {
        if (msg.type === 'exec_command') {
          send({ type: 'command_exit', callId: msg.callId, code: 7 })
        }
      },
    })
    const result = await proxyContainerCommand({
      agentDir: '/tmp/agent',
      commandName: 'fail',
      args: {},
      resolveUrl: fakeResolveUrl,
      websocketFactory: factory,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.exitCode).toBe(7)
  })

  test('QA-C12: command_error followed by command_exit resolves with ok:false + message', async () => {
    const { factory } = makeFakeWs({
      onMessage(msg, send) {
        if (msg.type === 'exec_command') {
          send({ type: 'command_error', callId: msg.callId, message: 'boom' })
          send({ type: 'command_exit', callId: msg.callId, code: 1 })
        }
      },
    })
    const result = await proxyContainerCommand({
      agentDir: '/tmp/agent',
      commandName: 'boom',
      args: {},
      resolveUrl: fakeResolveUrl,
      websocketFactory: factory,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.exitCode).toBe(1)
      expect(result.message).toBe('boom')
    }
  })

  test('QA-C13: abort signal sends command_abort frame', async () => {
    const abortController = new AbortController()
    const sentFrames: ClientMessage[] = []
    const { factory } = makeFakeWs({
      onMessage(msg, send) {
        sentFrames.push(msg)
        if (msg.type === 'exec_command') {
          return
        }
        if (msg.type === 'command_abort') {
          send({ type: 'command_exit', callId: msg.callId, code: 130 })
        }
      },
    })
    const promise = proxyContainerCommand({
      agentDir: '/tmp/agent',
      commandName: 'sleep',
      args: {},
      abortSignal: abortController.signal,
      resolveUrl: fakeResolveUrl,
      websocketFactory: factory,
    })
    await new Promise((r) => setTimeout(r, 10))
    abortController.abort(new Error('user-requested'))
    const result = await promise
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.exitCode).toBe(130)
    expect(sentFrames.some((f) => f.type === 'command_abort')).toBe(true)
  })

  test('returns failure with start-it hint when container not running', async () => {
    const result = await proxyContainerCommand({
      agentDir: '/tmp/agent',
      commandName: 'whatever',
      args: {},
      resolveUrl: async () => ({ error: 'container test-agent is not running; start it with `typeclaw start`' }),
      websocketFactory: () => {
        throw new Error('websocketFactory should not be called when resolveUrl errors')
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.exitCode).toBe(2)
      expect(result.message).toMatch(/typeclaw start/)
    }
  })

  test('stdin frames are forwarded to the server then ended', async () => {
    const stdinSent: string[] = []
    let endSeen = false
    const { factory } = makeFakeWs({
      onMessage(msg, send) {
        if (msg.type === 'command_stdin') stdinSent.push(msg.chunk)
        if (msg.type === 'command_stdin_end') endSeen = true
        if (msg.type === 'exec_command') {
          setTimeout(() => {
            send({ type: 'command_exit', callId: msg.callId, code: 0 })
          }, 20)
        }
      },
    })
    const stdin = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('chunk one'))
        controller.enqueue(new TextEncoder().encode('chunk two'))
        controller.close()
      },
    })
    const result = await proxyContainerCommand({
      agentDir: '/tmp/agent',
      commandName: 'cat',
      args: {},
      stdin,
      resolveUrl: fakeResolveUrl,
      websocketFactory: factory,
    })
    expect(result.ok).toBe(true)
    expect(stdinSent.length).toBe(2)
    expect(endSeen).toBe(true)
  })

  test('local stdin error sends command_abort and settles with ok:false', async () => {
    const aborts: string[] = []
    const { factory } = makeFakeWs({
      onMessage(msg) {
        if (msg.type === 'command_abort') aborts.push(msg.reason)
      },
    })
    const erroringStdin = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('chunk before failure'))
        queueMicrotask(() => controller.error(new Error('disk read failed')))
      },
    })
    const result = await proxyContainerCommand({
      agentDir: '/tmp/agent',
      commandName: 'reader',
      args: {},
      stdin: erroringStdin,
      resolveUrl: fakeResolveUrl,
      websocketFactory: factory,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.exitCode).toBe(1)
      expect(result.message).toMatch(/disk read failed/)
    }
    expect(aborts.length).toBeGreaterThanOrEqual(1)
    expect(aborts[0]).toMatch(/disk read failed/)
  })

  test('frames with a foreign callId are ignored; only matching frames mutate state', async () => {
    const captured: string[] = []
    const { factory } = makeFakeWs({
      onMessage(msg, send) {
        if (msg.type === 'exec_command') {
          // Send a frame for an UNRELATED callId first; the proxy must
          // ignore it. Then send the matching exit.
          send({ type: 'command_stdout', callId: 'someone-else', chunk: btoa('LEAK') })
          send({ type: 'command_error', callId: 'someone-else', message: 'wrong recipient' })
          send({ type: 'command_stdout', callId: msg.callId, chunk: btoa('mine') })
          send({ type: 'command_exit', callId: msg.callId, code: 0 })
        }
      },
    })
    const stdout = new WritableStream<Uint8Array>({
      write(chunk) {
        captured.push(new TextDecoder().decode(chunk))
      },
    })
    const result = await proxyContainerCommand({
      agentDir: '/tmp/agent',
      commandName: 'isolated',
      args: {},
      stdout,
      resolveUrl: fakeResolveUrl,
      websocketFactory: factory,
    })
    expect(result.ok).toBe(true)
    expect(captured.join('')).toBe('mine')
    expect(captured.join('')).not.toContain('LEAK')
  })
})
