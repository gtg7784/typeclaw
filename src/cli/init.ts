import { cancel, confirm, intro, isCancel, password, spinner } from '@clack/prompts'
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

    // TODO: provider/model selection. For now we assume Fireworks + Kimi K2.6 Turbo
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

    const wantDiscord = await confirm({
      message: 'Wire a Discord bot? (You can add this later by editing typeclaw.json + .env.)',
      initialValue: false,
    })
    if (isCancel(wantDiscord)) {
      cancel('Aborted.')
      process.exit(0)
    }
    let discordBotToken: string | undefined
    if (wantDiscord) {
      const token = await password({
        message: 'Discord bot token',
        validate: (value) => (value && value.length > 0 ? undefined : 'Token is required'),
      })
      if (isCancel(token)) {
        cancel('Aborted.')
        process.exit(0)
      }
      discordBotToken = token
      const allowAll = await confirm({
        message:
          'Set channels.discord-bot.allow = ["*"]? This admits every channel in every guild the bot is in, plus all DMs. You can narrow it later by editing typeclaw.json.',
        initialValue: true,
      })
      if (isCancel(allowAll) || !allowAll) {
        console.log(
          'OK. The discord-bot adapter will be wired but `allow` will be empty; the adapter will run but not deliver any inbound or outbound until you edit typeclaw.json.',
        )
      }
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
