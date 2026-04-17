import { createClient } from './client'
import { createInput } from './input'
import { createRenderer } from './renderer'

export type TuiOptions = {
  url: string
  initialPrompt?: string
}

export function createTui({ url, initialPrompt }: TuiOptions) {
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
      renderer.userPrompt(initialPrompt)
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
