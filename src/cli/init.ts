import { cancel, confirm, intro, isCancel, note, password, select, spinner } from '@clack/prompts'
import { defineCommand } from 'citty'

import { findAgentDir, isDirectoryNonEmpty, isHatched, runInit, type InitStep, type InitStepEvent } from '@/init'

export const init = defineCommand({
  meta: {
    name: 'init',
    description: 'initialize a new typeclaw agent in the current directory',
  },
  async run() {
    const cwd = process.cwd()

    const existingAgent = findAgentDir(cwd)
    if (existingAgent !== null && existingAgent !== cwd) {
      console.error(
        `Refusing to init: a TypeClaw agent already exists at ${existingAgent}. Nested agents are not supported.`,
      )
      process.exit(1)
    }

    if (await isHatched(cwd)) {
      console.error(`TypeClaw has already hatched in ${cwd}.`)
      process.exit(1)
    }

    if (isDirectoryNonEmpty(cwd)) {
      const proceed = await confirm({
        message: `You're at ${cwd}. The directory is not empty. Do you want to proceed?`,
        initialValue: false,
      })
      if (isCancel(proceed) || !proceed) {
        cancel('Aborted.')
        process.exit(0)
      }
    }

    intro('Initializing TypeClaw...')

    // TODO: provider/model selection. For now we assume Fireworks + Kimi K2.5 Turbo
    // because that's the only provider wired up in src/agent/auth.ts and src/config.
    // Expand to a provider picker (OpenAI, Anthropic, Fireworks, ...) once the
    // provider abstraction lands (see TypeClaw.md Phase 4).
    const apiKey = await password({
      message: 'Put your Fireworks API key',
      validate: (value) => (value && value.length > 0 ? undefined : 'API key is required'),
    })
    if (isCancel(apiKey)) {
      cancel('Aborted.')
      process.exit(0)
    }

    const channelChoice = await select({
      message: 'Pick a channel to wire (you can add more later by editing typeclaw.json + .env)',
      options: [
        { value: 'slack', label: 'Slack' },
        { value: 'discord', label: 'Discord' },
        { value: 'telegram', label: 'Telegram' },
        { value: 'none', label: 'Skip — no channel right now' },
      ],
      initialValue: 'slack' as const,
    })
    if (isCancel(channelChoice)) {
      cancel('Aborted.')
      process.exit(0)
    }

    let discordBotToken: string | undefined
    let slackBotToken: string | undefined
    let slackAppToken: string | undefined
    let telegramBotToken: string | undefined

    if (channelChoice === 'discord') {
      note(
        [
          'https://discord.com/developers/applications',
          'New Application → Bot tab → Reset Token.',
          'Enable the MESSAGE CONTENT intent.',
        ].join('\n'),
        'Get a Discord bot token',
      )
      const token = await password({
        message: 'Discord bot token',
        validate: (value) => (value && value.length > 0 ? undefined : 'Token is required'),
      })
      if (isCancel(token)) {
        cancel('Aborted.')
        process.exit(0)
      }
      discordBotToken = token
    }

    if (channelChoice === 'slack') {
      note(
        [
          'https://api.slack.com/apps → Create New App → From scratch.',
          'OAuth & Permissions: install to workspace, copy the Bot User',
          '  OAuth Token (xoxb-...).',
          'Socket Mode: enable it, then create an App-Level Token with',
          '  connections:write scope (xapp-...).',
        ].join('\n'),
        'Get a Slack bot',
      )
      const botToken = await password({
        message: 'Slack bot token (xoxb-...)',
        validate: (value) =>
          value && value.length > 0
            ? value.startsWith('xoxb-')
              ? undefined
              : 'Bot token must start with "xoxb-"'
            : 'Token is required',
      })
      if (isCancel(botToken)) {
        cancel('Aborted.')
        process.exit(0)
      }
      slackBotToken = botToken
      const appToken = await password({
        message: 'Slack app-level token (xapp-...) — Socket Mode requires this',
        validate: (value) =>
          value && value.length > 0
            ? value.startsWith('xapp-')
              ? undefined
              : 'App-level token must start with "xapp-"'
            : 'Token is required',
      })
      if (isCancel(appToken)) {
        cancel('Aborted.')
        process.exit(0)
      }
      slackAppToken = appToken
    }

    if (channelChoice === 'telegram') {
      note(
        [
          'Open Telegram and message @BotFather.',
          '/newbot → pick a name and username, copy the HTTP API token',
          '  (looks like 1234567890:ABCdef...).',
          'In @BotFather: /setprivacy → Disable, so the bot can see group messages.',
        ].join('\n'),
        'Get a Telegram bot token',
      )
      const token = await password({
        message: 'Telegram bot token',
        validate: (value) =>
          value && value.length > 0
            ? /^\d+:/.test(value)
              ? undefined
              : 'Bot token must look like "<digits>:<secret>" (from @BotFather)'
            : 'Token is required',
      })
      if (isCancel(token)) {
        cancel('Aborted.')
        process.exit(0)
      }
      telegramBotToken = token
      note(
        [
          'Open https://t.me/<your_bot_username> (the username you picked in /newbot, ends in "bot").',
          'Tap Start in the chat — the agent will reply once it hatches.',
          'For groups: add the bot to the group, then @mention it or reply to its messages.',
        ].join('\n'),
        'Send your first message',
      )
    }

    // TODO: add remaining wizard steps from TypeClaw.md once their runtime lands:
    //   - git backup (url + PAT) — Phase 10
    //   - cron.json scaffolding — Phase 9
    //   - compose.yml registration in $HOME/.typeclaw — Phase 12
    let hatchingOk = false
    try {
      await runInit({
        cwd,
        apiKey,
        ...(discordBotToken !== undefined ? { discordBotToken } : {}),
        ...(slackBotToken !== undefined ? { slackBotToken, slackAppToken } : {}),
        ...(telegramBotToken !== undefined ? { telegramBotToken } : {}),
        onProgress: reportProgress((ok) => {
          hatchingOk = ok
        }),
      })
    } catch (error) {
      console.error(error)
      process.exit(1)
    }

    if (hatchingOk) {
      console.log('\nContainer is still running. Run `typeclaw tui` to reattach or `typeclaw stop` to stop.')
    }
  },
})

function reportProgress(onHatchingDone: (ok: boolean) => void): (event: InitStepEvent) => void {
  const spinners: Partial<Record<InitStepEvent['step'], ReturnType<typeof spinner>>> = {}

  return (event) => {
    if (event.step === 'hatching') {
      reportHatching(event)
      if (event.phase === 'done') onHatchingDone(event.result.ok)
      return
    }

    if (event.phase === 'start') {
      const s = spinner()
      s.start(START_MESSAGES[event.step])
      spinners[event.step] = s
      return
    }

    const s = spinners[event.step]
    if (!s) return

    switch (event.step) {
      case 'scaffold':
        s.stop('Egg laid. 🥚')
        break
      case 'install':
        s.stop(event.result.ok ? 'Dependencies installed.' : `Skipped bun install: ${event.result.reason}`)
        break
      case 'dockerfile':
        if (event.result.ok) {
          s.stop(event.result.devMode ? 'Dockerfile + compose.yml written (dev mode).' : 'Dockerfile written.')
        } else {
          s.stop(`Skipped Dockerfile: ${event.result.reason}`)
        }
        break
      case 'git':
        if (event.result.ok) {
          s.stop(event.result.skipped ? 'Git repository already exists.' : 'Git repository initialized.')
        } else {
          s.stop(`Skipped git init: ${event.result.reason}`)
        }
        break
    }
  }
}

// Hatching launches the container and foregrounds the TUI, so it steals stdin
// and cannot share the spinner lifecycle with the other steps. Print plain
// lines instead.
function reportHatching(event: Extract<InitStepEvent, { step: 'hatching' }>): void {
  if (event.phase === 'start') {
    console.log('Hatching...')
    return
  }
  if (event.result.ok) {
    console.log('Hatched. 🐣')
  } else {
    console.error(`Hatching failed: ${event.result.reason}`)
  }
}

const START_MESSAGES: Record<Exclude<InitStep, 'hatching'>, string> = {
  scaffold: 'Laying the egg...',
  install: 'Installing dependencies with bun...',
  dockerfile: 'Writing Dockerfile...',
  git: 'Initializing git repository...',
}
