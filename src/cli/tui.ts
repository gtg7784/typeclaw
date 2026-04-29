import { defineCommand } from 'citty'

import { loadConfigSync } from '@/config'
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
      description: 'agent websocket url (defaults to ws://localhost:<port> from the resolved agent folder)',
    },
  },
  async run({ args }) {
    const url = args.url ?? defaultUrl()
    const tui = createTui({ url, initialPrompt: args.prompt })
    await tui.run()
  },
})

function defaultUrl(): string {
  const cwd = findAgentDir(process.cwd()) ?? process.cwd()
  return `ws://localhost:${loadConfigSync(cwd).port}`
}
