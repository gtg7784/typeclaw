import { defineCommand } from 'citty'

import { requireContainerRunning, resolveHostPort, resolveTuiToken } from '@/container'
import { findAgentDir } from '@/init'
import { CLI_VERSION } from '@/init/cli-version'
import { runTuiViewer } from '@/inspect'
import { formatVersionMismatchWarning } from '@/tui'

import { runInspectViewer } from './inspect'
import { errorLine } from './ui'

export const tui = defineCommand({
  meta: {
    name: 'tui',
    description: 'open the live agent session in the read+write viewer (host stage)',
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
    const cwd = findAgentDir(process.cwd()) ?? process.cwd()
    const resolveUrl: () => Promise<string> =
      args.url !== undefined ? async () => args.url as string : () => defaultUrl(cwd)

    const result = await runTuiViewer({
      resolveUrl,
      ...(args.prompt !== undefined ? { initialPrompt: args.prompt } : {}),
      expectedVersion: CLI_VERSION,
      onVersionMismatch: (info) => {
        process.stderr.write(`${formatVersionMismatchWarning(info)}\n`)
      },
      stderr: (line) => process.stderr.write(`${line}\n`),
    })

    // Esc detached from the live session: drop into the viewer list so the user
    // can pick another session or the container logs — `tui` is just a deep-link
    // into the session viewer, pre-opened on the live session. allowWritable
    // is false because detaching ended the live session, so no row may be
    // offered as a writable "live TUI" anymore.
    if (result.ok && result.escToPicker === true) {
      const viewerExit = await runInspectViewer({ cwd, allowWritable: false })
      process.exit(viewerExit)
      return
    }

    if (!result.ok) {
      process.stderr.write(`${errorLine(result.reason)}\n`)
      process.exit(result.exitCode)
    }
    process.exit(result.exitCode)
  },
})

async function defaultUrl(cwd: string): Promise<string> {
  const precheck = await requireContainerRunning({ cwd })
  if (!precheck.ok) throw new Error(precheck.reason)
  const port = await resolveHostPort({ cwd })
  const token = await resolveTuiToken({ cwd })
  const url = new URL(`ws://127.0.0.1:${port}`)
  if (token !== null) url.searchParams.set('token', token)
  return url.toString()
}
