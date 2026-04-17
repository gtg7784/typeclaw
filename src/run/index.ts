import { createServer, type Server } from '@/server'
import { createTui as createTuiDefault, type TuiOptions } from '@/tui'

type BunServer = ReturnType<Server['start']>

export type TuiFactory = (options: TuiOptions) => { run: () => Promise<void> }

export type StartAgentOptions = {
  port: number
  attachTui: boolean
  initialPrompt?: string
  createTui?: TuiFactory
}

export type StartAgentResult = {
  server: BunServer
  tuiPromise: Promise<void> | null
  stop: () => void
}

export function startAgent({
  port,
  attachTui,
  initialPrompt,
  createTui = createTuiDefault,
}: StartAgentOptions): StartAgentResult {
  const server = createServer({ port }).start()
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    server.stop(true)
  }

  if (!attachTui) {
    return { server, tuiPromise: null, stop }
  }

  const url = `ws://localhost:${server.port}`
  const tui = createTui({ url, initialPrompt })
  const tuiPromise = tui.run()
  return { server, tuiPromise, stop }
}
