import { Editor, Key, Markdown, matchesKey, ProcessTerminal, type Terminal, Text, TUI } from '@mariozechner/pi-tui'

import { createClient as createClientDefault, type Client } from './client'
import { formatToolEnd, formatToolStart, formatUserPromptHistory } from './format'
import { colors, editorTheme, markdownTheme } from './theme'

export type ClientFactory = (url: string) => Promise<Client>
export type TerminalFactory = () => Terminal

export type TuiOptions = {
  url: string
  initialPrompt?: string
  displayInitialPrompt?: string
  createClient?: ClientFactory
  createTerminal?: TerminalFactory
  exit?: (code: number) => void
}

export function createTui({
  url,
  initialPrompt,
  displayInitialPrompt,
  createClient = createClientDefault,
  createTerminal = () => new ProcessTerminal(),
  exit = process.exit.bind(process),
}: TuiOptions) {
  async function run(): Promise<void> {
    const terminal = createTerminal()
    const tui = new TUI(terminal)

    const status = new Text(colors.dim(`connecting to ${url}...`), 0, 0)
    tui.addChild(status)
    tui.start()
    tui.requestRender()

    const client = await createClient(url).catch((err) => {
      status.setText(colors.red(`connection error: ${err instanceof Error ? err.message : String(err)}`))
      tui.requestRender()
      tui.stop()
      exit(1)
      throw err
    })

    const sessionId = await new Promise<string>((resolve) => {
      let off: (() => void) | undefined
      off = client.onMessage((msg) => {
        if (msg.type === 'connected') {
          off?.()
          resolve(msg.sessionId)
        }
      })
    })
    status.setText(colors.dim(`session: ${sessionId}`))
    tui.requestRender()

    const editor = new Editor(tui, editorTheme, { paddingX: 0 })
    let replyInFlight = false
    let onReplyDone: (() => void) | null = null
    let currentAssistant: Markdown | null = null
    let currentAssistantText = ''

    // Pi-tui's Container.addChild appends to the end of the children array.
    // The editor must remain the LAST child at all times so it stays pinned
    // to the bottom of the viewport, with chat history scrolling above it.
    // Any new history entry is inserted by removing the editor, appending the
    // entry, and re-appending the editor. The editor instance is reused so
    // its internal state (text, cursor, history) survives the swap.
    const appendHistory = (component: Text | Markdown) => {
      tui.removeChild(editor)
      tui.addChild(component)
      tui.addChild(editor)
    }

    // Reset between text segments so a new Markdown block is created after
    // any non-text event (tool calls). Otherwise text_delta after a tool call
    // would append to the previous Markdown and visually push the tool lines
    // down on every chunk.
    const sealAssistantBlock = () => {
      currentAssistant = null
      currentAssistantText = ''
    }

    const finishAssistantTurn = () => {
      sealAssistantBlock()
      replyInFlight = false
      onReplyDone?.()
      onReplyDone = null
    }

    const ensureAssistantBlock = (): Markdown => {
      if (currentAssistant) return currentAssistant
      const md = new Markdown('', 0, 0, markdownTheme)
      currentAssistant = md
      currentAssistantText = ''
      appendHistory(md)
      return md
    }

    client.onMessage((msg) => {
      switch (msg.type) {
        case 'text_delta': {
          const block = ensureAssistantBlock()
          currentAssistantText += msg.delta
          block.setText(currentAssistantText)
          tui.requestRender()
          break
        }
        case 'tool_start': {
          sealAssistantBlock()
          appendHistory(new Text(formatToolStart(msg.name, msg.args), 0, 0))
          tui.requestRender()
          break
        }
        case 'tool_end': {
          sealAssistantBlock()
          appendHistory(new Text(formatToolEnd(msg.name, msg.error, msg.result, msg.durationMs), 0, 0))
          tui.requestRender()
          break
        }
        case 'done': {
          finishAssistantTurn()
          tui.requestRender()
          break
        }
        case 'error': {
          appendHistory(new Text(colors.red(`error: ${msg.message}`), 0, 0))
          finishAssistantTurn()
          tui.requestRender()
          break
        }
      }
    })

    const closed = new Promise<void>((resolve) => {
      client.onClose(() => {
        appendHistory(new Text(colors.dim('disconnected'), 0, 0))
        tui.requestRender()
        resolve()
      })
    })

    function send(text: string): Promise<void> {
      replyInFlight = true
      client.send({ type: 'prompt', text })
      return new Promise<void>((resolve) => {
        onReplyDone = resolve
      })
    }

    // Esc aborts an in-flight reply. The Editor does not bind Esc, so a
    // top-level input listener can intercept it without fighting the editor.
    tui.addInputListener((data) => {
      if (matchesKey(data, Key.escape) && replyInFlight) {
        client.send({ type: 'abort' })
        return { consume: true }
      }
      return undefined
    })

    // Ctrl+C exits cleanly. In raw mode the kernel does NOT generate SIGINT,
    // so we must intercept the \x03 byte ourselves. The Editor would otherwise
    // swallow it. tui.stop() restores raw-mode/cursor/echo before we exit.
    tui.addInputListener((data) => {
      if (matchesKey(data, Key.ctrl('c'))) {
        tui.stop()
        client.close()
        exit(0)
        return { consume: true }
      }
      return undefined
    })

    editor.onSubmit = (text) => {
      if (text.trim().length === 0) return
      appendHistory(new Text(formatUserPromptHistory(text), 0, 0))
      editor.setText('')
      editor.addToHistory(text)
      tui.requestRender()
      void send(text)
    }
    tui.addChild(editor)
    tui.setFocus(editor)
    tui.requestRender()

    if (initialPrompt) {
      appendHistory(new Text(formatUserPromptHistory(displayInitialPrompt ?? initialPrompt), 0, 0))
      tui.requestRender()
      await send(initialPrompt)
    }

    await closed
    tui.stop()
  }

  return { run }
}
