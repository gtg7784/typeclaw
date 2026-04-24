import { describe, expect, test } from 'bun:test'

import type { Terminal } from '@mariozechner/pi-tui'

import type { ClientMessage, ServerMessage } from '@/shared'

import { type Client } from './client'
import { createTui } from './index'

// oxlint-disable-next-line no-control-regex -- intentionally strips ESC and BEL from rendered ANSI/APC sequences
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b_[^\x07]*\x07/g, '')

class FakeTerminal implements Terminal {
  written: string[] = []
  rows = 30
  columns = 80
  kittyProtocolActive = false
  inputHandler: ((data: string) => void) | null = null
  resizeHandler: (() => void) | null = null
  stopped = false

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inputHandler = onInput
    this.resizeHandler = onResize
  }

  stop(): void {
    this.stopped = true
  }

  async drainInput(): Promise<void> {}

  write(data: string): void {
    this.written.push(data)
  }

  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}

  feed(data: string): void {
    this.inputHandler?.(data)
  }

  joined(): string {
    return this.written.join('')
  }

  visible(): string {
    return stripAnsi(this.joined())
  }
}

type FakeClient = Client & {
  emit: (msg: ServerMessage) => void
  triggerClose: () => void
  sent: ClientMessage[]
}

type FakeClientOptions = {
  autoDoneOnPrompt?: boolean
  autoDoneOnAbort?: boolean
}

function fakeClient(options: FakeClientOptions = {}): FakeClient {
  const autoDoneOnPrompt = options.autoDoneOnPrompt ?? true
  const autoDoneOnAbort = options.autoDoneOnAbort ?? false
  const listeners = new Set<(msg: ServerMessage) => void>()
  const closeListeners = new Set<() => void>()
  const pending: ServerMessage[] = []
  const sent: ClientMessage[] = []
  const broadcast = (msg: ServerMessage) => {
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
    onClose: (fn) => {
      closeListeners.add(fn)
    },
    onError: () => {},
    send: (msg) => {
      sent.push(msg)
      if (msg.type === 'prompt' && autoDoneOnPrompt) queueMicrotask(() => broadcast({ type: 'done' }))
      if (msg.type === 'abort' && autoDoneOnAbort) queueMicrotask(() => broadcast({ type: 'done' }))
    },
    close: () => {
      for (const fn of closeListeners) fn()
    },
    emit: broadcast,
    triggerClose: () => {
      for (const fn of closeListeners) fn()
    },
    sent,
  }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 30))

describe('createTui', () => {
  test('renders the initial prompt as a user history line and sends it to the server', async () => {
    // given
    const terminal = new FakeTerminal()
    const client = fakeClient()
    client.emit({ type: 'connected', sessionId: 'sid-1' })

    // when
    const tui = createTui({
      url: 'ws://ignored',
      initialPrompt: '<hatching>secret</hatching>\n\nHello!',
      displayInitialPrompt: 'Hello!',
      createClient: async () => client,
      createTerminal: () => terminal,
    })
    const runPromise = tui.run()
    await flush()
    client.triggerClose()
    await runPromise

    // then
    expect(client.sent).toEqual([{ type: 'prompt', text: '<hatching>secret</hatching>\n\nHello!' }])
    expect(terminal.visible()).toContain('> Hello!')
    expect(terminal.visible()).not.toContain('secret')
  })

  test('streams assistant text into the chat history (user input is not overwritten)', async () => {
    // given: an in-flight stream that we drive chunk by chunk while the user types
    const terminal = new FakeTerminal()
    const client = fakeClient({ autoDoneOnPrompt: false })
    client.emit({ type: 'connected', sessionId: 'sid-stream' })

    const tui = createTui({
      url: 'ws://ignored',
      initialPrompt: 'go',
      createClient: async () => client,
      createTerminal: () => terminal,
    })
    const runPromise = tui.run()
    await flush()

    // when: stream three chunks interleaved with user keystrokes
    client.emit({ type: 'text_delta', delta: '안녕' })
    await flush()
    terminal.feed('h')
    await flush()
    client.emit({ type: 'text_delta', delta: '하세요' })
    await flush()
    terminal.feed('i')
    await flush()
    client.emit({ type: 'text_delta', delta: '!' })
    await flush()
    client.emit({ type: 'done' })
    await flush()

    // then: the assistant text appears intact in the rendered output
    const visible = terminal.visible()
    expect(visible).toContain('안녕하세요!')

    client.triggerClose()
    await runPromise
  })

  test('sends abort when Esc is pressed during an in-flight reply', async () => {
    // given
    const terminal = new FakeTerminal()
    const client = fakeClient({ autoDoneOnPrompt: false, autoDoneOnAbort: true })
    client.emit({ type: 'connected', sessionId: 'sid-abort' })

    const tui = createTui({
      url: 'ws://ignored',
      initialPrompt: 'go',
      createClient: async () => client,
      createTerminal: () => terminal,
    })
    const runPromise = tui.run()
    await flush()

    // when
    terminal.feed('\x1b')
    await flush()

    // then
    expect(client.sent).toContainEqual({ type: 'abort' })

    client.triggerClose()
    await runPromise
  })

  test('Ctrl+C closes the client, stops the TUI, and exits cleanly', async () => {
    // given: an in-flight reply that would otherwise keep run() awaiting forever,
    // so we can be sure Ctrl+C does its work even mid-turn.
    const terminal = new FakeTerminal()
    const client = fakeClient({ autoDoneOnPrompt: false })
    client.emit({ type: 'connected', sessionId: 'sid-ctrl-c' })
    let exitCode: number | undefined
    let clientClosed = false
    const originalClose = client.close
    client.close = () => {
      clientClosed = true
      originalClose()
    }

    const tui = createTui({
      url: 'ws://ignored',
      initialPrompt: 'go',
      createClient: async () => client,
      createTerminal: () => terminal,
      exit: (code) => {
        exitCode = code
      },
    })
    // Intentionally do NOT await tui.run(): in production Ctrl+C calls
    // process.exit which terminates the process; the in-flight `await send()`
    // never resolving is fine because the process is gone. The test verifies
    // the side effects of the Ctrl+C handler instead.
    void tui.run().catch(() => {})
    await flush()

    // when
    terminal.feed('\x03')
    await flush()

    // then
    expect(exitCode).toBe(0)
    expect(terminal.stopped).toBe(true)
    expect(clientClosed).toBe(true)
  })

  test('does not send abort when Esc is pressed with no reply in flight', async () => {
    // given: connect, finish initial prompt, then idle
    const terminal = new FakeTerminal()
    const client = fakeClient()
    client.emit({ type: 'connected', sessionId: 'sid-idle' })

    const tui = createTui({
      url: 'ws://ignored',
      initialPrompt: 'go',
      createClient: async () => client,
      createTerminal: () => terminal,
    })
    const runPromise = tui.run()
    await flush()

    // when
    terminal.feed('\x1b')
    await flush()

    // then
    expect(client.sent).toEqual([{ type: 'prompt', text: 'go' }])

    client.triggerClose()
    await runPromise
  })

  test('keeps the editor pinned at the bottom: every new history entry renders ABOVE the editor', async () => {
    // given
    const terminal = new FakeTerminal()
    const client = fakeClient({ autoDoneOnPrompt: false })
    client.emit({ type: 'connected', sessionId: 'sid-pin' })

    const tui = createTui({
      url: 'ws://ignored',
      initialPrompt: 'first',
      createClient: async () => client,
      createTerminal: () => terminal,
    })
    const runPromise = tui.run()
    await flush()

    // when: drive a full turn (assistant text + tool + done) so multiple
    // history entries are appended after the editor was first added
    client.emit({ type: 'text_delta', delta: 'reply text' })
    await flush()
    client.emit({ type: 'tool_start', toolCallId: 't', name: 'Read', args: {} })
    await flush()
    client.emit({ type: 'tool_end', toolCallId: 't', name: 'Read', error: false, result: 'r', durationMs: 1 })
    await flush()
    client.emit({ type: 'done' })
    await flush()

    // then: every history marker appears BEFORE the editor's bottom border in
    // the rendered output. The editor draws horizontal box-drawing borders
    // (U+2500) above and below itself, so its position in the buffer is the
    // last occurrence of that character.
    const visible = terminal.visible()
    const lastEditorBorderIdx = visible.lastIndexOf('─')
    const userPromptIdx = visible.indexOf('> first')
    const assistantTextIdx = visible.indexOf('reply text')
    const toolStartIdx = visible.indexOf('● Read')
    const toolEndIdx = visible.indexOf('✓ Read')
    expect(lastEditorBorderIdx).toBeGreaterThan(-1)
    expect(userPromptIdx).toBeGreaterThan(-1)
    expect(assistantTextIdx).toBeGreaterThan(-1)
    expect(toolStartIdx).toBeGreaterThan(-1)
    expect(toolEndIdx).toBeGreaterThan(-1)
    expect(userPromptIdx).toBeLessThan(lastEditorBorderIdx)
    expect(assistantTextIdx).toBeLessThan(lastEditorBorderIdx)
    expect(toolStartIdx).toBeLessThan(lastEditorBorderIdx)
    expect(toolEndIdx).toBeLessThan(lastEditorBorderIdx)

    client.triggerClose()
    await runPromise
  })

  test('shows a tool start and end line in the chat history', async () => {
    // given
    const terminal = new FakeTerminal()
    const client = fakeClient({ autoDoneOnPrompt: false })
    client.emit({ type: 'connected', sessionId: 'sid-tool' })

    const tui = createTui({
      url: 'ws://ignored',
      initialPrompt: 'list files',
      createClient: async () => client,
      createTerminal: () => terminal,
    })
    const runPromise = tui.run()
    await flush()

    // when
    client.emit({ type: 'tool_start', toolCallId: 't1', name: 'Read', args: { path: '/x' } })
    await flush()
    client.emit({ type: 'tool_end', toolCallId: 't1', name: 'Read', error: false, result: 'hello', durationMs: 42 })
    await flush()
    client.emit({ type: 'done' })
    await flush()

    // then
    const visible = terminal.visible()
    expect(visible).toContain('● Read')
    expect(visible).toContain('✓ Read')
    expect(visible).toContain('42ms')

    client.triggerClose()
    await runPromise
  })
})
