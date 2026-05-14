import { defineCommand } from 'citty'

import { resolveHostPort, resolveTuiToken } from '@/container'
import { findAgentDir } from '@/init'
import { createTui } from '@/tui'

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
    const url = args.url ?? (await defaultUrl())
    const tui = createTui({ url, initialPrompt: args.prompt })
    await tui.run()
  },
})

async function defaultUrl(): Promise<string> {
  const cwd = findAgentDir(process.cwd()) ?? process.cwd()
  const port = await resolveHostPort({ cwd })
  const token = await resolveTuiToken({ cwd })
  const url = new URL(`ws://127.0.0.1:${port}`)
  if (token !== null) url.searchParams.set('token', token)
  return url.toString()
}
