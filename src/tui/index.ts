import { createClient as createClientDefault, type Client } from './client'
import { createInput as createInputDefault, type Input } from './input'
import { createRenderer as createRendererDefault, type Renderer } from './renderer'

export type ClientFactory = (url: string) => Promise<Client>
export type InputFactory = () => Input
export type RendererFactory = () => Renderer

export type TuiOptions = {
  url: string
  initialPrompt?: string
  displayInitialPrompt?: string
  createClient?: ClientFactory
  createInput?: InputFactory
  createRenderer?: RendererFactory
}

export function createTui({
  url,
  initialPrompt,
  displayInitialPrompt,
  createClient = createClientDefault,
  createInput = createInputDefault,
  createRenderer = createRendererDefault,
}: TuiOptions) {
  async function run() {
    const renderer = createRenderer()
    const input = createInput()

    renderer.connecting(url)

    const client = await createClient(url).catch((err) => {
      renderer.connectError(err)
      process.exit(1)
    })

    let onReplyDone: (() => void) | null = null

    const sessionId = await new Promise<string>((resolve) => {
      let off: (() => void) | undefined
      off = client.onMessage((msg) => {
        if (msg.type === 'connected') {
          off?.()
          resolve(msg.sessionId)
        }
      })
    })
    renderer.connected(sessionId)

    client.onMessage((msg) => {
      renderer.message(msg)
      if (msg.type === 'done' || msg.type === 'error') onReplyDone?.()
    })

    client.onClose(() => {
      renderer.disconnected()
      input.close()
      process.exit(0)
    })

    async function send(text: string) {
      client.send({ type: 'prompt', text })
      await new Promise<void>((resolve) => {
        onReplyDone = resolve
      })
    }

    if (initialPrompt) {
      renderer.userPrompt(displayInitialPrompt ?? initialPrompt)
      await send(initialPrompt)
    }

    for await (const line of input.lines()) {
      await send(line)
    }

    client.close()
    input.close()
  }

  return { run }
}
