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
    const url = args.url ?? (await defaultUrl())
    const tui = createTui({
      url,
      ...(args.prompt !== undefined ? { initialPrompt: args.prompt } : {}),
      expectedVersion: CLI_VERSION,
      onVersionMismatch: (info) => {
        process.stderr.write(`${formatVersionMismatchWarning(info)}\n`)
      },
    })
    await tui.run()
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
