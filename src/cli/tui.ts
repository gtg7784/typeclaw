import { defineCommand } from 'citty'

import { requireContainerRunning, resolveHostPort, resolveTuiToken } from '@/container'
import { CLI_VERSION } from '@/init/cli-version'
import { runTuiViewer } from '@/inspect'
import { formatVersionMismatchWarning } from '@/tui'

import { runInspectViewer } from './inspect'
import { requireAgentDir } from './require-agent-dir'
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
    // An explicit --url targets an agent over the wire and needs no local agent
    // folder — only the default-URL discovery and the esc-detach picker read
    // local state. Require an agent folder only when --url is absent, mirroring
    // how reload/cron/role claim gate their default-target path, not the whole
    // command.
    const explicitUrl = typeof args.url === 'string' ? args.url : undefined
    let cwd: string | undefined
    let resolveUrl: () => Promise<string>
    if (explicitUrl === undefined) {
      const agentDir = requireAgentDir()
      cwd = agentDir
      resolveUrl = () => defaultUrl(agentDir)
    } else {
      cwd = undefined
      resolveUrl = async () => explicitUrl
    }

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
    // offered as a writable "live TUI" anymore. A --url-only run has no local
    // agent folder to browse, so it exits instead of opening the local picker.
    if (result.ok && result.escToPicker === true && cwd !== undefined) {
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
