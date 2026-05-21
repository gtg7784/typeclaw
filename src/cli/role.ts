import { intro, note, outro, spinner } from '@clack/prompts'
import { defineCommand } from 'citty'

import { requireContainerRunning, resolveHostPort, resolveTuiToken } from '@/container'
import { findAgentDir } from '@/init'
import { runClaimSession } from '@/role-claim'

import { c, errorLine } from './ui'

const claimSub = defineCommand({
  meta: {
    name: 'claim',
    description:
      'claim a channel identity (Slack/Discord/etc.) for a role on this agent. Sends a code via the host CLI; you DM that code back to the bot to prove control of the channel account.',
  },
  args: {
    as: {
      type: 'string',
      description: 'which role to claim (owner | member | trusted | <custom>)',
      default: 'owner',
    },
    channel: {
      type: 'string',
      description: 'restrict the claim to one channel adapter (slack-bot | discord-bot | telegram-bot | kakaotalk)',
    },
    ttl: {
      type: 'string',
      description: 'how long the code stays valid, in milliseconds',
      default: '600000',
    },
    url: {
      type: 'string',
      description: 'agent websocket url (defaults to ws://127.0.0.1:<host port> discovered from the running container)',
    },
  },
  async run({ args }) {
    const url = args.url ?? (await defaultUrl())
    const ttlMs = Number(args.ttl)
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      console.error(errorLine(`--ttl must be a positive integer (milliseconds); got "${args.ttl}"`))
      process.exit(1)
    }

    intro(`Claiming "${args.as}" role`)

    const s = spinner()
    s.start('Waiting for code...')

    let started = false
    const result = await runClaimSession({
      url,
      role: args.as,
      ttlMs,
      ...(args.channel !== undefined ? { channel: args.channel } : {}),
      onStarted: (payload) => {
        started = true
        s.stop('Ready.')
        const expiresInSec = Math.max(0, Math.round((payload.expiresAt - Date.now()) / 1000))
        const lines = [
          `Send this message to your bot as a DM:`,
          '',
          `  ${c.bold(payload.code)}`,
          '',
          `(expires in ${formatDuration(expiresInSec)})`,
        ]
        note(lines.join('\n'), 'Claim code')
        const waitMsg =
          payload.channel !== undefined ? `Listening on ${payload.channel}...` : 'Listening on all wired channels...'
        s.start(waitMsg)
      },
    })

    if (!started) {
      s.stop('Failed to start claim session.')
    }

    if (result.kind === 'completed') {
      s.stop(c.green(`Paired as ${result.payload.role}.`))
      outro(`Match rule added: ${c.bold(result.payload.matchRule)}`)
      return
    }
    if (result.kind === 'error') {
      s.stop(c.red(`Claim failed: ${result.payload.reason}`))
      process.exit(1)
    }
    s.stop(c.red(`Claim timed out. Run "typeclaw role claim" again to retry.`))
    process.exit(1)
  },
})

const listSub = defineCommand({
  meta: {
    name: 'list',
    description: 'show the roles declared on this agent (typeclaw.json#roles)',
  },
  async run() {
    const cwd = findAgentDir(process.cwd()) ?? process.cwd()
    // Diagnostic command: route through `loadConfigSyncOrDefaults` (same
    // soft-fail pattern as PR #288's `status`/`doctor` and the follow-up for
    // `model list`) so a broken `typeclaw.json` doesn't crash the very
    // command users reach for to see which roles the agent thinks it has.
    // Defaults have no `roles` block, so the empty-state hint fires next.
    const { loadConfigSyncOrDefaults } = await import('@/config')
    const config = loadConfigSyncOrDefaults(cwd)
    if (!config.roles || Object.keys(config.roles).length === 0) {
      console.log(c.dim('No roles declared. Run `typeclaw role claim` to add one, or edit typeclaw.json by hand.'))
      return
    }
    for (const [name, role] of Object.entries(config.roles)) {
      console.log(c.bold(name))
      if (role.match.length === 0) {
        console.log(`  ${c.dim('(no match rules)')}`)
      }
      for (const rule of role.match) {
        console.log(`  match: ${describeRule(rule)}`)
      }
      if (role.permissions !== undefined) {
        for (const perm of role.permissions) {
          console.log(`  permission: ${perm}`)
        }
      }
    }
  },
})

export const roleCommand = defineCommand({
  meta: {
    name: 'role',
    description: 'manage role memberships on this agent',
  },
  subCommands: {
    claim: () => Promise.resolve(claimSub),
    list: () => Promise.resolve(listSub),
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

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (s === 0) return `${m}m`
  return `${m}m ${s}s`
}

function describeRule(rule: unknown): string {
  return JSON.stringify(rule)
}
