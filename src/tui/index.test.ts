import { describe, expect, test } from 'bun:test'

import type { ClientMessage, ServerMessage } from '@/shared'

import { type Client } from './client'
import { createTui } from './index'
import { type Input } from './input'
import { type Renderer } from './renderer'

type RendererCall = { kind: 'userPrompt'; text: string } | { kind: 'connecting' | 'connected' | 'disconnected' }

function fakeRenderer(calls: RendererCall[]): Renderer {
  return {
    connecting: () => {
      calls.push({ kind: 'connecting' })
      return true
    },
    connected: () => {
      calls.push({ kind: 'connected' })
      return true
    },
    disconnected: () => {
      calls.push({ kind: 'disconnected' })
      return true
    },
    connectError: () => true,
    userPrompt: (text) => {
      calls.push({ kind: 'userPrompt', text })
      return true
    },
    message: () => {},
  }
}

function fakeInput(): Input {
  async function* lines(): AsyncGenerator<string, void, void> {
    // no interactive input - exit immediately so run() can return
  }
  return { lines, close: () => {} }
}

type FakeClient = Client & { emit: (msg: ServerMessage) => void; sent: ClientMessage[] }

// Fake WebSocket client that mirrors the real one on two points that matter
// for the tui orchestrator: (1) messages sent before any listener is attached
// are buffered and replayed on first subscribe (the real `createClient` does
// this too), and (2) every `prompt` send is eventually followed by a `done`
// frame from the server.
function fakeClient(): FakeClient {
  const listeners = new Set<(msg: ServerMessage) => void>()
  const pending: ServerMessage[] = []
  const sent: ClientMessage[] = []
  const emit = (msg: ServerMessage) => {
    if (listeners.size === 0) {
      pending.push(msg)
      return
    }
    for (const fn of listeners) fn(msg)
  }
  return {
    onMessage: (fn) => {
      listeners.add(fn)
      if (pending.length > 0) {
        const buffered = pending.splice(0)
        for (const msg of buffered) fn(msg)
      }
      return () => listeners.delete(fn)
    },
    onClose: () => {},
    onError: () => {},
    send: (msg) => {
      sent.push(msg)
      if (msg.type === 'prompt') queueMicrotask(() => emit({ type: 'done' }))
    },
    close: () => {},
    emit,
    sent,
  }
}

describe('createTui', () => {
  test('renders displayInitialPrompt to the user but sends the full initialPrompt to the server', async () => {
    // given
    const calls: RendererCall[] = []
    const client = fakeClient()
    client.emit({ type: 'connected', sessionId: 'sid-test' })
    const tui = createTui({
      url: 'ws://ignored',
      initialPrompt: '<hatching>secret instructions</hatching>\n\nHello!',
      displayInitialPrompt: 'Hello!',
      createClient: async () => client,
      createInput: fakeInput,
      createRenderer: () => fakeRenderer(calls),
    })

    // when
    await tui.run()

    // then
    const userPromptCalls = calls.filter((c): c is { kind: 'userPrompt'; text: string } => c.kind === 'userPrompt')
    expect(userPromptCalls).toEqual([{ kind: 'userPrompt', text: 'Hello!' }])
    expect(client.sent).toEqual([{ type: 'prompt', text: '<hatching>secret instructions</hatching>\n\nHello!' }])
  })

  test('falls back to initialPrompt when no displayInitialPrompt is given', async () => {
    // given
    const calls: RendererCall[] = []
    const client = fakeClient()
    client.emit({ type: 'connected', sessionId: 'sid-test' })
    const tui = createTui({
      url: 'ws://ignored',
      initialPrompt: 'just this',
      createClient: async () => client,
      createInput: fakeInput,
      createRenderer: () => fakeRenderer(calls),
    })

    // when
    await tui.run()

    // then: user sees exactly what was sent to the server
    const userPromptCalls = calls.filter((c): c is { kind: 'userPrompt'; text: string } => c.kind === 'userPrompt')
    expect(userPromptCalls).toEqual([{ kind: 'userPrompt', text: 'just this' }])
    expect(client.sent).toEqual([{ type: 'prompt', text: 'just this' }])
  })
})
