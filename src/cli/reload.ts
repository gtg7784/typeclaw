import { defineCommand } from 'citty'

import { resolveHostPort } from '@/container'
import { findAgentDir } from '@/init'
import { requestReload, type ReloadResult } from '@/reload'

export const reload = defineCommand({
  meta: {
    name: 'reload',
    description: "reload the running agent's reloadable subsystems (cron, ...)",
  },
  args: {
    url: {
      type: 'string',
      description:
        "agent websocket url (defaults to ws://localhost:<host port> discovered from the running container's published port)",
    },
    timeout: {
      type: 'string',
      description: 'milliseconds to wait for the agent to respond',
      default: '30000',
    },
  },
  async run({ args }) {
    const url = args.url ?? (await defaultUrl())
    let results: ReloadResult[]
    try {
      results = await requestReload({ url, timeoutMs: Number(args.timeout) })
    } catch (err) {
      console.error(`reload failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }

    if (results.length === 0) {
      console.log('Nothing to reload.')
      return
    }

    let failed = 0
    for (const r of results) {
      if (r.ok) {
        console.log(`[${r.scope}] ok: ${r.summary}`)
      } else {
        failed++
        console.error(`[${r.scope}] failed: ${r.reason}`)
      }
    }

    if (failed > 0) {
      process.exit(1)
    }
  },
})

async function defaultUrl(): Promise<string> {
  const cwd = findAgentDir(process.cwd()) ?? process.cwd()
  const port = await resolveHostPort({ cwd })
  return `ws://localhost:${port}`
}
