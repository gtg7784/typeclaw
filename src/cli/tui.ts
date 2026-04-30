import { defineCommand } from 'citty'

import { resolveHostPort } from '@/container'
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
        "agent websocket url (defaults to ws://localhost:<host port> discovered from the running container's published port)",
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
  return `ws://localhost:${port}`
}
