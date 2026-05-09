import { cancel, confirm, intro, isCancel, log, note, password, select, spinner, text } from '@clack/prompts'
import { defineCommand } from 'citty'

import {
  KNOWN_PROVIDERS,
  supportsApiKey as providerSupportsApiKey,
  supportsOAuth as providerSupportsOAuth,
  type KnownModelRef,
  type KnownProviderId,
} from '@/config/providers'
import type { DockerAvailability } from '@/container'
import {
  findAgentDir,
  isDirectoryNonEmpty,
  isHatched,
  runInit,
  type InitStep,
  type InitStepEvent,
  type KakaotalkAuthResult,
  type LLMAuth,
} from '@/init'
import { runKakaotalkBootstrap } from '@/init/kakaotalk-auth'
import { fetchModelOptions, type ModelOption } from '@/init/models-dev'
import { makeOAuthLoginRunner } from '@/init/oauth-login'

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

    const selectedModel = await pickModel()
    const provider = KNOWN_PROVIDERS[selectedModel.providerId]

    const llmAuth = await collectLLMAuth(provider)

    const channelChoice = await select({
      message: 'Pick a channel to wire (you can add more later by editing typeclaw.json + .env)',
      options: [
        { value: 'slack', label: 'Slack' },
        { value: 'discord', label: 'Discord' },
        { value: 'telegram', label: 'Telegram' },
        { value: 'kakaotalk', label: 'KakaoTalk' },
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
    let kakaotalkEmail: string | undefined
    let kakaotalkPassword: string | undefined

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

    if (channelChoice === 'kakaotalk') {
      note(
        [
          'KakaoTalk authentication uses a personal account, registered as a',
          'tablet sub-device. Messages will be sent and received under this',
          'account. Use a non-primary account if possible.',
          '',
          'After you submit the password, KakaoTalk may ask you to confirm a',
          'passcode on your phone. Watch the screen for the code.',
        ].join('\n'),
        'About to log in to KakaoTalk',
      )
      const email = await text({
        message: 'KakaoTalk email',
        validate: (value) => (value && value.length > 0 ? undefined : 'Email is required'),
      })
      if (isCancel(email)) {
        cancel('Aborted.')
        process.exit(0)
      }
      const pwd = await password({
        message: 'KakaoTalk password',
        validate: (value) => (value && value.length > 0 ? undefined : 'Password is required'),
      })
      if (isCancel(pwd)) {
        cancel('Aborted.')
        process.exit(0)
      }
      kakaotalkEmail = email
      kakaotalkPassword = pwd
    }

    if (channelChoice === 'slack') {
      note(
        [
          '1. https://api.slack.com/apps → Create New App → From a manifest.',
          '   Pick your workspace, then paste this JSON manifest:',
          '',
          '   {',
          '     "display_information": { "name": "TypeClaw" },',
          '     "features": {',
          '       "bot_user": { "display_name": "TypeClaw", "always_online": true }',
          '     },',
          '     "oauth_config": {',
          '       "scopes": {',
          '         "bot": [',
          '           "app_mentions:read", "chat:write", "users:read", "files:read",',
          '           "channels:history", "channels:read",',
          '           "groups:history",   "groups:read",',
          '           "im:history",       "im:read",',
          '           "mpim:history",     "mpim:read"',
          '         ]',
          '       }',
          '     },',
          '     "settings": {',
          '       "event_subscriptions": {',
          '         "bot_events": [',
          '           "app_mention",',
          '           "message.channels", "message.groups",',
          '           "message.im",       "message.mpim"',
          '         ]',
          '       },',
          '       "socket_mode_enabled": true',
          '     }',
          '   }',
          '',
          '2. Install to Workspace, then OAuth & Permissions →',
          '   copy the Bot User OAuth Token (xoxb-...).',
          '3. Basic Information → App-Level Tokens → Generate Token and',
          '   Scopes, add the connections:write scope, and copy the',
          '   token (xapp-...). Socket Mode needs this; the manifest',
          '   cannot grant it.',
          '4. Invite the bot to any private channel or DM you want it in:',
          '   /invite @TypeClaw',
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
      note(
        [
          'Slack does not accept connections:write inside the manifest, so',
          'this token has to be generated by hand:',
          '',
          '1. Basic Information → App-Level Tokens → Generate Token and Scopes.',
          '2. Token Name: anything (e.g. "socket-mode").',
          '3. Add Scope → connections:write → Generate.',
          '4. Copy the xapp-... token shown once on screen.',
          '   (You cannot retrieve it later — only revoke and regenerate.)',
        ].join('\n'),
        'Generate the Slack app-level token',
      )
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
    const wantsKakaotalk = kakaotalkEmail !== undefined && kakaotalkPassword !== undefined
    let hatchingOk = false
    let preflightFailure: Extract<DockerAvailability, { ok: false }> | null = null
    try {
      await runInit({
        cwd,
        llmAuth,
        model: selectedModel.ref,
        ...(discordBotToken !== undefined ? { discordBotToken } : {}),
        ...(slackBotToken !== undefined ? { slackBotToken, slackAppToken } : {}),
        ...(telegramBotToken !== undefined ? { telegramBotToken } : {}),
        ...(wantsKakaotalk
          ? {
              withKakaotalk: true,
              runKakaotalkAuth: ({ cwd: agentDir }) =>
                runKakaotalkBootstrap({
                  email: kakaotalkEmail!,
                  password: kakaotalkPassword!,
                  agentDir,
                  callbacks: {
                    onPasscode: (code) => log.info(`Confirm this passcode on your phone: ${code}`),
                  },
                }),
            }
          : {}),
        onProgress: reportProgress(
          (ok) => {
            hatchingOk = ok
          },
          (result) => {
            preflightFailure = result
          },
        ),
      })
    } catch (error) {
      console.error(error)
      process.exit(1)
    }

    if (preflightFailure !== null) {
      note(preflightFailureGuidance(preflightFailure).join('\n'), 'Docker check failed')
      process.exit(1)
    }

    if (hatchingOk) {
      console.log('\nContainer is still running. Run `typeclaw tui` to reattach or `typeclaw stop` to stop.')
    }
  },
})

function reportProgress(
  onHatchingDone: (ok: boolean) => void,
  onPreflightFail: (result: Extract<DockerAvailability, { ok: false }>) => void,
): (event: InitStepEvent) => void {
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
      case 'preflight':
        if (event.result.ok) {
          s.stop('Docker is reachable.')
        } else {
          s.error(preflightFailureSummary(event.result))
          onPreflightFail(event.result)
        }
        break
      case 'scaffold':
        s.stop('Egg laid. 🥚')
        break
      case 'kakaotalk-auth':
        s.stop(reportKakaotalkAuth(event.result))
        break
      case 'oauth-login':
        s.stop(event.result.ok ? 'Logged in.' : `OAuth login failed: ${event.result.reason}`)
        break
      case 'install':
        s.stop(event.result.ok ? 'Dependencies installed.' : `Skipped bun install: ${event.result.reason}`)
        break
      case 'dockerfile':
        if (event.result.ok) {
          s.stop(event.result.devMode ? 'Dockerfile written (dev mode).' : 'Dockerfile written.')
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

function preflightFailureSummary(result: Extract<DockerAvailability, { ok: false }>): string {
  if (result.reason === 'binary-missing') return 'Docker is not installed.'
  return 'Docker is installed but the daemon is not reachable.'
}

function preflightFailureGuidance(result: Extract<DockerAvailability, { ok: false }>): string[] {
  if (result.reason === 'binary-missing') {
    return [
      'TypeClaw runs every agent inside its own Docker container, so Docker is required.',
      '',
      'Install one of:',
      '  • Docker Desktop — https://docs.docker.com/get-docker/',
      '  • OrbStack (macOS, lighter) — https://orbstack.dev',
      '',
      'Then re-run `typeclaw init`.',
    ]
  }
  return [
    'The docker CLI is on $PATH, but the daemon refused the connection:',
    '',
    `  ${result.detail}`,
    '',
    'Start Docker Desktop / OrbStack (or `sudo systemctl start docker` on Linux),',
    'then re-run `typeclaw init`.',
  ]
}

function reportKakaotalkAuth(result: KakaotalkAuthResult): string {
  if (result.ok) return 'KakaoTalk credentials saved to workspace/.agent-messenger/.'
  return `KakaoTalk login failed: ${result.reason}`
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

// Resolves how the user wants to authenticate to the chosen provider:
// - api-key only (e.g. Fireworks): prompt for the key, write to .env.
// - oauth only (e.g. openai-codex): run the browser flow inline, write
//   auth.json. No API key prompt at all.
// - both supported (no providers ship this today, but Anthropic will when
//   wired): ask "API key or OAuth?" first, then dispatch to the chosen path.
async function collectLLMAuth(provider: (typeof KNOWN_PROVIDERS)[KnownProviderId]): Promise<LLMAuth> {
  const supportsApiKey = providerSupportsApiKey(provider)
  const supportsOAuth = providerSupportsOAuth(provider)

  let method: 'api-key' | 'oauth'
  if (supportsApiKey && supportsOAuth) {
    const choice = await select<'api-key' | 'oauth'>({
      message: `How do you want to authenticate to ${provider.name}?`,
      options: [
        { value: 'api-key', label: 'API key', hint: `saved to .env as ${provider.apiKeyEnv}` },
        { value: 'oauth', label: 'OAuth (browser login)', hint: 'saved to auth.json' },
      ],
      initialValue: 'api-key',
    })
    if (isCancel(choice)) {
      cancel('Aborted.')
      process.exit(0)
    }
    method = choice
  } else if (supportsOAuth) {
    method = 'oauth'
  } else {
    method = 'api-key'
  }

  if (method === 'api-key') {
    const apiKey = await password({
      message: `Put your ${provider.name} API key (will be saved to .env as ${provider.apiKeyEnv})`,
      validate: (value) => (value && value.length > 0 ? undefined : 'API key is required'),
    })
    if (isCancel(apiKey)) {
      cancel('Aborted.')
      process.exit(0)
    }
    return { kind: 'api-key', apiKey }
  }

  return { kind: 'oauth', runLogin: makeOAuthLoginRunner(buildOAuthCallbacks(provider.name)) }
}

// Wraps the OAuth lifecycle into the same clack idiom the rest of the wizard
// uses: a spinner over the "waiting for login" period, with onAuth printing
// the URL the user needs to open and onPrompt falling back to a `text`
// prompt for the manual code path. The spinner is started by onAuth and
// stopped by the caller (runInit) — we don't try to manage it here because
// the spinner lifecycle has to span emit('start') -> emit('done').
function buildOAuthCallbacks(providerName: string) {
  return {
    onAuth: (url: string, instructions?: string) => {
      // Don't put the URL inside note(): clack wraps long lines with the box
      // border `│` on each wrapped segment, which corrupts the URL when the
      // user copy-pastes it. Keep instructional text in the box, but print
      // the URL itself as a bare console.log line that any terminal will
      // hyperlink intact.
      const preamble = [`Open this URL in your browser to authorize ${providerName}.`]
      if (instructions) preamble.push('', instructions)
      note(preamble.join('\n'), 'Browser login')
      console.log(url)
      console.log('')
    },
    onProgress: (message: string) => {
      log.info(message)
    },
    onPrompt: async (message: string, placeholder?: string): Promise<string | null> => {
      const value = await text({ message, ...(placeholder !== undefined ? { placeholder } : {}) })
      if (isCancel(value)) return null
      return value
    },
  }
}

// Two-step provider+model picker. We split it because most users have a key
// for exactly one provider — asking them to scroll through a flat list of
// every (provider, model) pair would surface options they can't use.
async function pickModel(): Promise<ModelOption> {
  const s = spinner()
  s.start('Loading model catalog from models.dev...')
  const { options, source, warning } = await fetchModelOptions()
  if (source === 'curated') {
    s.stop(`Using built-in catalog (models.dev unavailable: ${warning ?? 'unknown'})`)
  } else {
    s.stop('Loaded model catalog.')
  }

  const providers = uniqueProviders(options)
  const providerChoice = await select({
    message: 'Pick an LLM provider',
    options: providers.map((id) => ({ value: id, label: KNOWN_PROVIDERS[id].name, hint: providerAuthHint(id) })),
    initialValue: providers[0],
  })
  if (isCancel(providerChoice)) {
    cancel('Aborted.')
    process.exit(0)
  }

  const candidates = options.filter((o) => o.providerId === providerChoice)
  const modelChoice = await select<KnownModelRef>({
    message: `Pick a ${KNOWN_PROVIDERS[providerChoice].name} model`,
    options: candidates.map((o) => ({
      value: o.ref,
      label: o.modelName,
      hint: formatModelHint(o),
    })),
    initialValue: candidates[0]?.ref,
  })
  if (isCancel(modelChoice)) {
    cancel('Aborted.')
    process.exit(0)
  }

  const picked = candidates.find((o) => o.ref === modelChoice)
  if (!picked) throw new Error(`Internal error: picked model ${modelChoice} not in candidates`)
  return picked
}

function uniqueProviders(options: ModelOption[]): KnownProviderId[] {
  const seen = new Set<KnownProviderId>()
  const out: KnownProviderId[] = []
  for (const o of options) {
    if (seen.has(o.providerId)) continue
    seen.add(o.providerId)
    out.push(o.providerId)
  }
  return out
}

function formatModelHint(o: ModelOption): string {
  const parts: string[] = []
  if (o.contextWindow !== null) parts.push(`${(o.contextWindow / 1000).toFixed(0)}K ctx`)
  if (o.reasoning) parts.push('reasoning')
  return parts.join(' · ')
}

function providerAuthHint(id: KnownProviderId): string {
  const provider = KNOWN_PROVIDERS[id]
  const apiKey = providerSupportsApiKey(provider)
  const oauth = providerSupportsOAuth(provider)
  if (apiKey && oauth) return 'API key or OAuth'
  if (oauth) return 'OAuth login'
  return 'API key'
}

const START_MESSAGES: Record<Exclude<InitStep, 'hatching'>, string> = {
  preflight: 'Checking Docker...',
  'oauth-login': 'Waiting for browser login...',
  scaffold: 'Laying the egg...',
  'kakaotalk-auth': 'Logging in to KakaoTalk...',
  install: 'Installing dependencies with bun...',
  dockerfile: 'Writing Dockerfile...',
  git: 'Initializing git repository...',
}
