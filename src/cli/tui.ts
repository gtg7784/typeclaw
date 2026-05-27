import { defineCommand } from 'citty'

import { requireContainerRunning, resolveHostPort, resolveTuiToken } from '@/container'
import { findAgentDir } from '@/init'
import { CLI_VERSION } from '@/init/cli-version'
import { createTui, formatVersionMismatchWarning } from '@/tui'

import { errorLine } from './ui'

export const tui = defineCommand({
  meta: {
    name: 'tui',
    description: 'start the tui client',
  },
  args: {
    prompt: {
      type: 'positional',
      description: 'initial prompt',
      required: false,
    },
    url: {
      type: 'string',
      description:
        "agent websocket url (defaults to ws://127.0.0.1:<host port> discovered from the running container's published port)",
    },
  },
  async run({ args }) {
    const resolveUrl: () => Promise<string> = args.url !== undefined ? async () => args.url as string : defaultUrl

    let initialPrompt: string | undefined = args.prompt
    let attempt = 0
    const RECONNECT_MAX_ATTEMPTS = 30
    const RECONNECT_BACKOFF_MS = 1_000

    while (true) {
      const url = await resolveUrl()
      const tui = createTui({
        url,
        ...(initialPrompt !== undefined ? { initialPrompt } : {}),
        expectedVersion: CLI_VERSION,
        onVersionMismatch: (info) => {
          process.stderr.write(`${formatVersionMismatchWarning(info)}\n`)
        },
      })
      const outcome = await tui.run()
      if (!outcome.lostConnection) return
      // The TUI lost its WS post-handshake (container restart, network blip,
      // hostd hiccup). Re-resolve the URL because the host port can change
      // across container lifecycles (see resolveHostPort), then reconnect.
      // The initial prompt is intentionally cleared after the first cycle:
      // on a reconnect, the agent is resuming the same session — replaying
      // the prompt would re-send it to the LLM.
      initialPrompt = undefined
      attempt += 1
      if (attempt > RECONNECT_MAX_ATTEMPTS) {
        console.error(errorLine(`disconnected; gave up after ${RECONNECT_MAX_ATTEMPTS} reconnect attempts`))
        process.exit(1)
      }
      process.stderr.write(`reconnecting (attempt ${attempt}/${RECONNECT_MAX_ATTEMPTS})...\n`)
      await new Promise((resolve) => setTimeout(resolve, RECONNECT_BACKOFF_MS))
    }
  },
})

async function defaultUrl(): Promise<string> {
  const cwd = findAgentDir(process.cwd()) ?? process.cwd()
  const precheck = await requireContainerRunning({ cwd })
  if (!precheck.ok) {
    console.error(errorLine(precheck.reason))
    process.exit(1)
  }
  const port = await resolveHostPort({ cwd })
  const token = await resolveTuiToken({ cwd })
  const url = new URL(`ws://127.0.0.1:${port}`)
  if (token !== null) url.searchParams.set('token', token)
  return url.toString()
}
