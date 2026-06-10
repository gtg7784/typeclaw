import { defineCommand } from 'citty'

import { requireContainerRunning, resolveHostPort, resolveTuiToken } from '@/container'
import { findAgentDir } from '@/init'
import { requestReloadWithFallback, type ReloadResult } from '@/reload'

import { c, errorLine, spinner } from './ui'

export const reload = defineCommand({
  meta: {
    name: 'reload',
    description: "reload the running agent's reloadable subsystems (cron, ...)",
  },
  args: {
    url: {
      type: 'string',
      description:
        "agent websocket url (defaults to ws://127.0.0.1:<host port> discovered from the running container's published port)",
    },
    timeout: {
      type: 'string',
      description: 'milliseconds to wait for the agent to respond',
      default: '30000',
    },
  },
  async run({ args }) {
    const timeoutMs = Number(args.timeout)
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      console.error(errorLine(`invalid --timeout value: ${args.timeout}`))
      process.exit(1)
    }

    const target = args.url === undefined ? await defaultTarget() : { url: args.url }

    const s = spinner()
    s.start('Reloading...')
    let results: ReloadResult[]
    let recoveredHostError: string | undefined
    try {
      const response = await requestReloadWithFallback({ ...target, timeoutMs })
      results = response.results
      if (response.transport === 'container-local') recoveredHostError = response.hostError
    } catch (err) {
      s.error(`reload failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }

    printReloadRecoveryHint(recoveredHostError)

    if (results.length === 0) {
      s.stop(c.dim('Nothing to reload.'))
      return
    }

    let failed = 0
    for (const r of results) {
      if (!r.ok) failed++
    }
    s.stop(failed === 0 ? `Reloaded ${results.length} scope(s).` : `Reloaded with ${failed} failure(s).`)

    for (const r of results) {
      if (r.ok) {
        console.log(`${c.green('●')} ${c.bold(`[${r.scope}]`)} ${r.summary}`)
      } else {
        console.error(`${c.red('●')} ${c.bold(`[${r.scope}]`)} ${errorLine(r.reason)}`)
      }
    }

    if (failed > 0) {
      process.exit(1)
    }
  },
})

export function printReloadRecoveryHint(recoveredHostError: string | undefined): void {
  if (recoveredHostError === undefined) return
  console.error(
    c.yellow(
      `Recovered via container-local reload because Docker's published host port is not accepting WebSockets (${recoveredHostError}).`,
    ),
  )
  console.error(c.dim('Run `typeclaw restart --port 0` when safe to repair host TUI/reload connectivity.'))
}

async function defaultTarget(): Promise<{ url: string; cwd: string; token: string | null }> {
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
  return { url: url.toString(), cwd, token }
}
