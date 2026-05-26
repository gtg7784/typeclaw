import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { cancel, confirm, intro, isCancel, log, note, password, select, spinner, text } from '@clack/prompts'
import { defineCommand } from 'citty'

import { config } from '@/config'
import { start, status, stop } from '@/container'
import {
  CHANNEL_KINDS,
  findAgentDir,
  formatEagerGithubWebhookInstallResult,
  isInitialized,
  readConfiguredChannels,
  readGithubAuthType,
  runAddChannel,
  setChannelSecrets,
  setGithubSecrets,
  type AddChannelStepEvent,
  type ChannelKind,
  type GithubCredentialPatch,
  type GithubTunnelProvider,
  type KakaotalkAuthResult,
} from '@/init'
import { runKakaotalkBootstrap } from '@/init/kakaotalk-auth'
import { SecretsKakaoCredentialStore } from '@/secrets/kakao-store'

import { c, done, errorLine, printSlackAppManifestSetup } from './ui'

const CHANNEL_LABELS: Record<ChannelKind, string> = {
  'slack-bot': 'Slack',
  'discord-bot': 'Discord',
  'telegram-bot': 'Telegram',
  kakaotalk: 'KakaoTalk',
  github: 'GitHub',
}

const addSub = defineCommand({
  meta: {
    name: 'add',
    description: 'add a new channel adapter to an existing agent (run this from inside the agent folder)',
  },
  args: {
    adapter: {
      type: 'positional',
      description: `which adapter to add (${CHANNEL_KINDS.join(' | ')}); omit to pick interactively`,
      required: false,
    },
  },
  async run({ args }) {
    const cwd = findAgentDir(process.cwd()) ?? process.cwd()

    if (!isInitialized(cwd)) {
      console.error(errorLine('TypeClaw config file not found. Run `typeclaw init` first, or cd into an agent folder.'))
      process.exit(1)
    }

    const configured = await readConfiguredChannels(cwd)
    const requested = args.adapter
    const channel = requested === undefined ? await pickChannel(configured) : validateAdapterArg(requested, configured)

    intro(`Adding channel: ${CHANNEL_LABELS[channel]}`)

    const credentials = await collectCredentials(channel)

    const events: AddChannelStepEvent[] = []
    try {
      await runAddChannel({
        cwd,
        ...credentials,
        onProgress: reportProgress(events),
      })
      if (credentials.channel === 'github' && credentials.tunnelProvider === 'none') {
        log.warn(
          'Webhook delivery is disabled until you add a `tunnels[]` entry or set `channels.github.webhookUrl` manually.',
        )
      }
    } catch (error) {
      console.error(errorLine(error instanceof Error ? error.message : String(error)))
      process.exit(1)
    }

    await maybePromptRestart(cwd, channel)
  },
})

// Adapters whose credentials are rotated via the generic `channel set` flow:
// one or more named token fields, no passcode-on-phone, no encryption envelope.
// KakaoTalk is excluded by design — it has its own `channel reauth` flow that
// replays the full interactive login (see REAUTHABLE_ADAPTERS below). GitHub
// is included here but routed through its own prompt path because it has
// three independent secrets (PAT or App private key + webhook secret) and a
// structural auth-type flip is forbidden during rotation.
const SETTABLE_ADAPTERS = ['slack-bot', 'discord-bot', 'telegram-bot', 'github'] as const
type SettableAdapter = (typeof SETTABLE_ADAPTERS)[number]

const setSub = defineCommand({
  meta: {
    name: 'set',
    description: 'rotate credentials of an already-configured channel adapter (symmetric with `typeclaw provider set`)',
  },
  args: {
    adapter: {
      type: 'positional',
      description: `which adapter to rotate (${SETTABLE_ADAPTERS.join(' | ')}); omit to pick interactively`,
      required: false,
    },
  },
  async run({ args }) {
    const cwd = findAgentDir(process.cwd()) ?? process.cwd()

    if (!isInitialized(cwd)) {
      console.error(errorLine('TypeClaw config file not found. Run `typeclaw init` first, or cd into an agent folder.'))
      process.exit(1)
    }

    const configured = await readConfiguredChannels(cwd)

    if (args.adapter === 'kakaotalk') {
      console.error(
        errorLine(
          'KakaoTalk uses an interactive auth flow (phone passcode + device_uuid). Use `typeclaw channel reauth kakaotalk` to rotate its credentials.',
        ),
      )
      process.exit(1)
    }

    const adapter =
      args.adapter === undefined
        ? await pickSettableAdapter(configured)
        : validateSetAdapterArg(args.adapter, configured)

    intro(`Rotating channel: ${CHANNEL_LABELS[adapter]}`)

    await runSet(cwd, adapter)
  },
})

const REAUTHABLE_ADAPTERS = ['kakaotalk'] as const
type ReauthableAdapter = (typeof REAUTHABLE_ADAPTERS)[number]

const reauthSub = defineCommand({
  meta: {
    name: 'reauth',
    description:
      're-authenticate a channel adapter (currently only `kakaotalk`). Use after a stale-token 401 or to rotate the saved password.',
  },
  args: {
    adapter: {
      type: 'positional',
      description: `which adapter to re-authenticate (${REAUTHABLE_ADAPTERS.join(' | ')})`,
      required: false,
    },
  },
  async run({ args }) {
    const cwd = findAgentDir(process.cwd()) ?? process.cwd()

    if (!isInitialized(cwd)) {
      console.error(errorLine('TypeClaw config file not found. Run `typeclaw init` first, or cd into an agent folder.'))
      process.exit(1)
    }

    const configured = await readConfiguredChannels(cwd)
    const adapter = await resolveReauthableAdapter(args.adapter, configured)

    intro(`Re-authenticating channel: ${CHANNEL_LABELS[adapter]}`)

    await runReauth(cwd, adapter)
  },
})

export const channelCommand = defineCommand({
  meta: {
    name: 'channel',
    description: 'manage channel adapters wired into the agent',
  },
  subCommands: {
    add: addSub,
    set: setSub,
    reauth: reauthSub,
  },
})

async function resolveReauthableAdapter(
  requested: string | undefined,
  configured: Set<ChannelKind>,
): Promise<ReauthableAdapter> {
  if (requested !== undefined) {
    if (!isReauthableAdapter(requested)) {
      console.error(
        errorLine(`Adapter "${requested}" does not support reauth. Supported: ${REAUTHABLE_ADAPTERS.join(', ')}.`),
      )
      process.exit(1)
    }
    if (!configured.has(requested)) {
      console.error(
        errorLine(
          `${CHANNEL_LABELS[requested]} ("${requested}") is not configured in typeclaw.json. Run \`typeclaw channel add ${requested}\` first.`,
        ),
      )
      process.exit(1)
    }
    return requested
  }

  const available = REAUTHABLE_ADAPTERS.filter((kind) => configured.has(kind))
  if (available.length === 0) {
    console.error(
      errorLine(
        `No reauth-capable channels are configured. Run \`typeclaw channel add ${REAUTHABLE_ADAPTERS[0]}\` first.`,
      ),
    )
    process.exit(1)
  }
  if (available.length === 1) return available[0]!

  const selected = await select<ReauthableAdapter>({
    message: 'Pick a channel to re-authenticate',
    options: available.map((kind) => ({ value: kind, label: CHANNEL_LABELS[kind] })),
    initialValue: available[0],
  })
  if (isCancel(selected)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return selected
}

function isReauthableAdapter(value: string): value is ReauthableAdapter {
  return (REAUTHABLE_ADAPTERS as ReadonlyArray<string>).includes(value)
}

async function runReauth(cwd: string, adapter: ReauthableAdapter): Promise<void> {
  switch (adapter) {
    case 'kakaotalk':
      await runKakaotalkReauth(cwd)
      return
  }
}

async function runKakaotalkReauth(cwd: string): Promise<void> {
  const existingEmail = await readExistingKakaotalkEmail(cwd)
  const creds = await promptKakaotalkCredentials({ defaultEmail: existingEmail })

  const s = spinner()
  s.start('Logging in to KakaoTalk...')
  const result = await runKakaotalkBootstrap({
    email: creds.email,
    password: creds.password,
    agentDir: cwd,
    callbacks: {
      onPasscode: (code) => log.info(`Confirm this passcode on your phone: ${code}`),
    },
  })
  if (!result.ok) {
    s.stop(`KakaoTalk login failed: ${result.reason}`)
    process.exit(1)
  }
  s.stop('KakaoTalk credentials refreshed in secrets.json.')

  await maybePromptReauthRefresh(cwd, 'kakaotalk')
}

async function readExistingKakaotalkEmail(cwd: string): Promise<string | undefined> {
  try {
    const store = new SecretsKakaoCredentialStore({ mode: 'host', secretsPath: `${cwd}/secrets.json` })
    const account = await store.getAccountWithRenewalFields()
    return account?.email ?? undefined
  } catch {
    // First-time reauth or a brand-new agent dir: no account yet, prompt from scratch.
    return undefined
  }
}

// The renewed tokens are already on disk via secrets.json. What still needs
// to happen depends on the running adapter's state:
//   - Container NOT running → nothing to do; next `typeclaw start` picks them up.
//   - Container running, adapter previously 401'd → `typeclaw reload` re-runs
//     startAdapter, which loads the fresh tokens.
//   - Container running, adapter currently live (e.g. proactive rotation) →
//     reload will report `restart-required` because tokens are captured at
//     start time; `typeclaw restart` is needed to actually pick them up.
// We can't reliably distinguish the last two cases from outside the container
// without calling reload first, so the next-step hints surface both paths.
async function maybePromptReauthRefresh(cwd: string, adapter: ReauthableAdapter): Promise<void> {
  await maybePromptCredentialRefresh(cwd, CHANNEL_LABELS[adapter], 're-authenticated')
}

async function maybePromptCredentialRefresh(
  cwd: string,
  label: string,
  verbPast: 're-authenticated' | 'credentials updated',
): Promise<void> {
  const current = await status({ cwd }).catch(() => null)
  if (current === null || current.kind !== 'running') {
    done({
      title: c.green(`${label} ${verbPast}.`),
      hints: [
        { label: 'Start the agent:', command: 'typeclaw start' },
        { label: 'Then check status:', command: 'typeclaw status' },
      ],
    })
    return
  }

  const restartNow = await confirm({
    message:
      'The agent container is running. Restart it now so the adapter picks up the fresh credentials (recommended)?',
    initialValue: true,
  })
  if (isCancel(restartNow) || !restartNow) {
    done({
      title: c.green(`${label} ${verbPast}.`),
      hints: [
        { label: 'Try a live reload first:', command: 'typeclaw reload' },
        { label: 'If reload reports restart-required:', command: 'typeclaw restart' },
      ],
    })
    return
  }

  const stopped = await stop({ cwd })
  if (!stopped.ok) {
    console.error(errorLine(`Restart failed during stop: ${stopped.reason}`))
    process.exit(1)
  }
  const started = await start({ cwd, preferredHostPort: config.port, cliEntry: process.argv[1] })
  if (!started.ok) {
    console.error(errorLine(`Restart failed during start: ${started.reason}`))
    process.exit(1)
  }
  done({
    title: c.green(`${label} ${verbPast}. Restarted ${started.plan.containerName} on host port ${started.hostPort}.`),
    hints: [
      { label: 'Attach TUI:', command: 'typeclaw tui' },
      { label: 'Follow logs:', command: 'typeclaw logs -f' },
    ],
  })
}

function validateAdapterArg(adapter: string, configured: Set<ChannelKind>): ChannelKind {
  if (!isChannelKind(adapter)) {
    console.error(errorLine(`Unknown adapter "${adapter}". Expected one of: ${CHANNEL_KINDS.join(', ')}.`))
    process.exit(1)
  }
  if (configured.has(adapter)) {
    console.error(
      errorLine(
        `${CHANNEL_LABELS[adapter]} ("${adapter}") is already configured in typeclaw.json. Edit the file directly to change its configuration.`,
      ),
    )
    process.exit(1)
  }
  return adapter
}

function isChannelKind(value: string): value is ChannelKind {
  return (CHANNEL_KINDS as ReadonlyArray<string>).includes(value)
}

async function pickChannel(configured: Set<ChannelKind>): Promise<ChannelKind> {
  const available = CHANNEL_KINDS.filter((kind) => !configured.has(kind))
  if (available.length === 0) {
    console.error(errorLine('All supported channel adapters are already configured in typeclaw.json. Nothing to add.'))
    process.exit(0)
  }

  const selected = await select<ChannelKind>({
    message: 'Pick a channel to add',
    options: available.map((kind) => ({ value: kind, label: CHANNEL_LABELS[kind] })),
    initialValue: available[0],
  })
  if (isCancel(selected)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return selected
}

function isSettableAdapter(value: string): value is SettableAdapter {
  return (SETTABLE_ADAPTERS as ReadonlyArray<string>).includes(value)
}

function validateSetAdapterArg(adapter: string, configured: Set<ChannelKind>): SettableAdapter {
  if (!isSettableAdapter(adapter)) {
    if (isChannelKind(adapter)) {
      console.error(
        errorLine(
          `Adapter "${adapter}" does not support \`channel set\`. Use \`typeclaw channel reauth ${adapter}\` instead.`,
        ),
      )
    } else {
      console.error(errorLine(`Unknown adapter "${adapter}". Expected one of: ${SETTABLE_ADAPTERS.join(', ')}.`))
    }
    process.exit(1)
  }
  if (!configured.has(adapter)) {
    console.error(
      errorLine(
        `${CHANNEL_LABELS[adapter]} ("${adapter}") is not configured in typeclaw.json. Run \`typeclaw channel add ${adapter}\` first.`,
      ),
    )
    process.exit(1)
  }
  return adapter
}

async function pickSettableAdapter(configured: Set<ChannelKind>): Promise<SettableAdapter> {
  const available = SETTABLE_ADAPTERS.filter((kind) => configured.has(kind))
  if (available.length === 0) {
    console.error(
      errorLine(
        'No rotatable channels are configured. Run `typeclaw channel add <adapter>` first, or use `typeclaw channel reauth kakaotalk` for KakaoTalk.',
      ),
    )
    process.exit(1)
  }
  if (available.length === 1) return available[0]!

  const selected = await select<SettableAdapter>({
    message: 'Pick a channel to rotate credentials for',
    options: available.map((kind) => ({ value: kind, label: CHANNEL_LABELS[kind] })),
    initialValue: available[0],
  })
  if (isCancel(selected)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return selected
}

async function runSet(cwd: string, adapter: SettableAdapter): Promise<void> {
  switch (adapter) {
    case 'discord-bot':
      await runSetDiscord(cwd)
      break
    case 'telegram-bot':
      await runSetTelegram(cwd)
      break
    case 'slack-bot':
      await runSetSlack(cwd)
      break
    case 'github':
      await runSetGithub(cwd)
      break
  }
}

async function runSetDiscord(cwd: string): Promise<void> {
  const token = await promptDiscordToken()
  const result = await setChannelSecrets(cwd, 'discord-bot', { token })
  if (!result.ok) {
    console.error(errorLine(result.reason))
    process.exit(1)
  }
  await maybePromptCredentialRefresh(cwd, CHANNEL_LABELS['discord-bot'], 'credentials updated')
}

async function runSetTelegram(cwd: string): Promise<void> {
  const token = await promptTelegramToken()
  const result = await setChannelSecrets(cwd, 'telegram-bot', { token })
  if (!result.ok) {
    console.error(errorLine(result.reason))
    process.exit(1)
  }
  await maybePromptCredentialRefresh(cwd, CHANNEL_LABELS['telegram-bot'], 'credentials updated')
}

type SlackSetChoice = 'bot' | 'app' | 'both'

async function runSetSlack(cwd: string): Promise<void> {
  note(
    [
      'Rotate at https://api.slack.com/apps → your app:',
      '  Bot token  (xoxb-...) — OAuth & Permissions → Reset Token.',
      '  App-level token (xapp-...) — Basic Information → App-Level Tokens → Revoke and regenerate.',
      'Slack only shows the app-level token once on screen — copy it before closing.',
    ].join('\n'),
    'Rotate the Slack tokens',
  )
  const choice = await select<SlackSetChoice>({
    message: 'Which Slack token do you want to rotate?',
    options: [
      { value: 'bot', label: 'Bot user token (xoxb-...) — used to post messages as the bot (recommended)' },
      { value: 'app', label: 'App-level token (xapp-...) — required for Socket Mode' },
      { value: 'both', label: 'Both tokens — rotate the bot token and the app-level token' },
    ],
    initialValue: 'bot',
  })
  if (isCancel(choice)) {
    cancel('Aborted.')
    process.exit(0)
  }

  const tokens: Record<string, string> = {}
  if (choice === 'bot' || choice === 'both') tokens.botToken = await promptSlackBotToken()
  if (choice === 'app' || choice === 'both') tokens.appToken = await promptSlackAppToken()

  const result = await setChannelSecrets(cwd, 'slack-bot', tokens)
  if (!result.ok) {
    console.error(errorLine(result.reason))
    process.exit(1)
  }
  await maybePromptCredentialRefresh(cwd, CHANNEL_LABELS['slack-bot'], 'credentials updated')
}

type GithubSetChoice = 'auth' | 'webhook' | 'both'

async function runSetGithub(cwd: string): Promise<void> {
  const authType = readGithubAuthType(cwd)
  if (authType === null) {
    console.error(
      errorLine(
        'GitHub auth block is missing or malformed in secrets.json. Run `typeclaw channel add github` first, or fix the file by hand.',
      ),
    )
    process.exit(1)
  }
  const authLabel =
    authType === 'pat'
      ? 'Auth credential — rotate the PAT, or switch to GitHub App auth (recommended)'
      : 'Auth credential — rotate the App private key, or switch to PAT auth (recommended)'
  const choice = await select<GithubSetChoice>({
    message: 'Which GitHub secret do you want to update?',
    options: [
      { value: 'auth', label: authLabel },
      { value: 'webhook', label: 'Webhook secret — shared secret for verifying GitHub payloads' },
      { value: 'both', label: 'Both secrets — update the auth credential and the webhook secret' },
    ],
    initialValue: 'auth',
  })
  if (isCancel(choice)) {
    cancel('Aborted.')
    process.exit(0)
  }

  const patch: GithubCredentialPatch = {}

  if (choice === 'auth' || choice === 'both') {
    patch.auth = await promptGithubAuthUpdate(authType)
  }

  if (choice === 'webhook' || choice === 'both') {
    const secret = await password({
      message: 'New webhook secret (leave blank to auto-generate)',
    })
    if (isCancel(secret)) {
      cancel('Aborted.')
      process.exit(0)
    }
    const enteredSecret = typeof secret === 'string' ? secret : ''
    patch.webhookSecret = enteredSecret.length > 0 ? enteredSecret : randomBytes(32).toString('hex')
  }

  const result = await setGithubSecrets(cwd, patch)
  if (!result.ok) {
    console.error(errorLine(result.reason))
    process.exit(1)
  }
  await maybePromptCredentialRefresh(cwd, CHANNEL_LABELS.github, 'credentials updated')
}

type CollectedCredentials =
  | { channel: 'discord-bot'; discordBotToken: string }
  | { channel: 'slack-bot'; slackBotToken: string; slackAppToken: string }
  | { channel: 'telegram-bot'; telegramBotToken: string }
  | { channel: 'kakaotalk'; runKakaotalkAuth: (options: { cwd: string }) => Promise<KakaotalkAuthResult> }
  | {
      channel: 'github'
      webhookSecret: string
      tunnelProvider: GithubTunnelProvider
      webhookUrl?: string
      webhookPort?: number
      repos: string[]
      auth: { type: 'pat'; pat: string } | { type: 'app'; appId: number; privateKey: string; installationId?: number }
    }

async function collectCredentials(channel: ChannelKind): Promise<CollectedCredentials> {
  switch (channel) {
    case 'discord-bot':
      return { channel, discordBotToken: await promptDiscordToken() }
    case 'slack-bot': {
      const slack = await promptSlackTokens()
      return { channel, slackBotToken: slack.bot, slackAppToken: slack.app }
    }
    case 'telegram-bot':
      return { channel, telegramBotToken: await promptTelegramToken() }
    case 'kakaotalk': {
      const creds = await promptKakaotalkCredentials()
      return {
        channel,
        runKakaotalkAuth: ({ cwd: agentDir }) =>
          runKakaotalkBootstrap({
            email: creds.email,
            password: creds.password,
            agentDir,
            callbacks: { onPasscode: (code) => log.info(`Confirm this passcode on your phone: ${code}`) },
          }),
      }
    }
    case 'github': {
      const creds = await promptGithubCredentials()
      return { channel, ...creds }
    }
  }
}

async function promptGithubCredentials(): Promise<{
  webhookSecret: string
  tunnelProvider: GithubTunnelProvider
  webhookUrl?: string
  webhookPort?: number
  hostname?: string
  tokenEnv?: string
  repos: string[]
  auth: { type: 'pat'; pat: string } | { type: 'app'; appId: number; privateKey: string; installationId?: number }
}> {
  note(
    [
      'Choose PAT auth for a quick setup, or GitHub App auth for expiring installation tokens.',
      'Required permissions: Issues read/write, Pull requests read/write, Discussions read/write (if used),',
      'Metadata read, and Webhooks read/write (TypeClaw will create and manage the repository webhooks for you).',
    ].join('\n'),
    'Get GitHub credentials',
  )
  const authType = await select({
    message: 'GitHub authentication type',
    options: [
      { value: 'pat', label: 'Fine-grained personal access token' },
      { value: 'app', label: 'GitHub App installation token' },
    ],
  })
  if (isCancel(authType)) {
    cancel('Aborted.')
    process.exit(0)
  }
  const auth = authType === 'pat' ? await promptGithubPatAuth() : await promptGithubAppAuth()
  note('GitHub webhooks need a public URL. TypeClaw can manage a tunnel for you.', 'GitHub webhook tunnel')
  const tunnelProvider = await select<GithubTunnelProvider>({
    message: 'Tunnel provider',
    options: [
      {
        value: 'cloudflare-quick',
        label: 'Cloudflare Quick Tunnel — no signup, URL rotates on restart (recommended)',
      },
      {
        value: 'cloudflare-named',
        label: 'Cloudflare Named Tunnel — stable URL, needs Cloudflare account + domain',
      },
      { value: 'external', label: 'External URL — I have my own reverse proxy / tunnel' },
      { value: 'none', label: 'None — configure later by hand-editing typeclaw.json' },
    ],
    initialValue: 'cloudflare-quick',
  })
  if (isCancel(tunnelProvider)) {
    cancel('Aborted.')
    process.exit(0)
  }
  const webhookUrl =
    tunnelProvider === 'external'
      ? await text({
          message: 'Public webhook URL (GitHub will POST events here)',
          validate: (value) => validateUrl(value ?? '', 'Webhook URL is required'),
        })
      : undefined
  if (isCancel(webhookUrl)) {
    cancel('Aborted.')
    process.exit(0)
  }
  const namedCreds = tunnelProvider === 'cloudflare-named' ? await promptCloudflareNamedTunnel() : undefined
  const port = await text({
    message: 'Local webhook port inside the agent container',
    initialValue: '8975',
    validate: (value) => {
      const parsed = Number(value)
      return Number.isInteger(parsed) && parsed > 0 ? undefined : 'Port must be a positive integer'
    },
  })
  if (isCancel(port)) {
    cancel('Aborted.')
    process.exit(0)
  }
  const secret = await password({
    message: 'Webhook secret (leave blank to auto-generate)',
  })
  if (isCancel(secret)) {
    cancel('Aborted.')
    process.exit(0)
  }
  // clack's password() returns `undefined` on an empty submission (it has no
  // validate guard and never coerces to ''), so we normalize before the
  // length checks below to avoid a TypeError on the "leave blank" path.
  const enteredSecret = typeof secret === 'string' ? secret : ''
  const reposRaw = await text({
    message: 'Repositories to allow (comma-separated owner/repo)',
    validate: (value) => (parseRepos(value ?? '').length > 0 ? undefined : 'At least one owner/repo is required'),
  })
  if (isCancel(reposRaw)) {
    cancel('Aborted.')
    process.exit(0)
  }
  const resolvedSecret = enteredSecret.length > 0 ? enteredSecret : randomBytes(32).toString('hex')
  return {
    webhookSecret: resolvedSecret,
    tunnelProvider,
    ...(webhookUrl !== undefined ? { webhookUrl } : {}),
    webhookPort: Number(port),
    ...(namedCreds !== undefined ? namedCreds : {}),
    repos: parseRepos(reposRaw),
    auth,
  }
}

async function promptCloudflareNamedTunnel(): Promise<{ hostname: string; tokenEnv: string }> {
  note(
    [
      'Cloudflare Named Tunnel needs a tunnel you created in the Zero Trust dashboard:',
      '  1. Networks → Tunnels → Create a tunnel → Cloudflared. Copy the token shown on the install screen.',
      '  2. Public Hostname tab → Add: subdomain + your-domain, service type HTTP, URL localhost:<webhook port>.',
      '  3. Put the token in .env under the env var name you supply below.',
      'A tunnel without a Public Hostname registers but routes nothing.',
    ].join('\n'),
    'Cloudflare named tunnel',
  )
  const hostname = await text({
    message: 'Public hostname configured in the dashboard (https://...)',
    validate: (value) => validateUrl(value ?? '', 'Hostname is required'),
  })
  if (isCancel(hostname)) {
    cancel('Aborted.')
    process.exit(0)
  }
  const tokenEnv = await text({
    message: 'Env var name holding the tunnel token',
    initialValue: 'CLOUDFLARE_TUNNEL_TOKEN',
    validate: (value) => {
      const v = value ?? ''
      if (v.trim().length === 0) return 'Env var name is required'
      if (!/^[A-Z_][A-Z0-9_]*$/.test(v)) {
        return 'Must be an env var name like CLOUDFLARE_TUNNEL_TOKEN (uppercase, digits, underscore)'
      }
      return undefined
    },
  })
  if (isCancel(tokenEnv)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return { hostname, tokenEnv }
}

type GithubAuthUpdateAction = 'rotate' | 'switch'

async function promptGithubAuthUpdate(currentType: 'pat' | 'app'): Promise<GithubCredentialPatch['auth']> {
  const rotateLabel =
    currentType === 'pat'
      ? 'Rotate the PAT (replace the current personal access token)'
      : 'Rotate the App private key (replace the current GitHub App private key)'
  const switchLabel =
    currentType === 'pat'
      ? 'Switch to GitHub App auth (replace the PAT with App credentials)'
      : 'Switch to PAT auth (replace the App credentials with a personal access token)'
  const action = await select<GithubAuthUpdateAction>({
    message: 'Update the GitHub auth credential',
    options: [
      { value: 'rotate', label: rotateLabel },
      { value: 'switch', label: switchLabel },
    ],
    initialValue: 'rotate',
  })
  if (isCancel(action)) {
    cancel('Aborted.')
    process.exit(0)
  }

  const nextType: 'pat' | 'app' = action === 'rotate' ? currentType : currentType === 'pat' ? 'app' : 'pat'

  if (nextType === 'pat') {
    if (action === 'rotate') {
      note(
        [
          'Rotate at https://github.com/settings/personal-access-tokens.',
          'Required permissions: Issues read/write, Pull requests read/write, Discussions read/write (if used),',
          'Metadata read, and Webhooks read/write.',
        ].join('\n'),
        'Rotate the GitHub PAT',
      )
    } else {
      note(
        [
          'Create a fine-grained PAT at https://github.com/settings/personal-access-tokens.',
          'Required permissions: Issues read/write, Pull requests read/write, Discussions read/write (if used),',
          'Metadata read, and Webhooks read/write.',
        ].join('\n'),
        'Switch to GitHub PAT auth',
      )
    }
    return await promptGithubPatAuth()
  }

  if (action === 'rotate') {
    note(
      [
        'Rotate at https://github.com/settings/apps/<your-app> → Private keys → Generate a private key.',
        'GitHub immediately downloads the new .pem. The previous key keeps working until you delete it,',
        'so it is safe to rotate without downtime.',
      ].join('\n'),
      'Rotate the GitHub App private key',
    )
    const privateKeyInput = await text({
      message: 'New GitHub App private key PEM, escaped PEM, or path to .pem file',
      validate: (value) => (value && value.length > 0 ? undefined : 'Private key is required'),
    })
    if (isCancel(privateKeyInput)) {
      cancel('Aborted.')
      process.exit(0)
    }
    return { type: 'app', privateKey: await resolvePrivateKeyInput(privateKeyInput) }
  }

  note(
    [
      'Create a GitHub App at https://github.com/settings/apps/new and install it on your repositories.',
      'Required permissions: Issues read/write, Pull requests read/write, Discussions read/write (if used),',
      'Metadata read, and Webhooks read/write.',
      'Then collect the App ID, generate a private key (.pem), and grab the Installation ID from the URL',
      'of the installation page (https://github.com/settings/installations/<installation-id>).',
    ].join('\n'),
    'Switch to GitHub App auth',
  )
  return await promptGithubAppAuth()
}

async function promptGithubPatAuth(): Promise<{ type: 'pat'; pat: string }> {
  const pat = await password({
    message: 'GitHub fine-grained PAT',
    validate: (value) => (value && value.length > 0 ? undefined : 'PAT is required'),
  })
  if (isCancel(pat)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return { type: 'pat', pat }
}

async function promptGithubAppAuth(): Promise<{
  type: 'app'
  appId: number
  privateKey: string
  installationId?: number
}> {
  const appId = await text({
    message: 'GitHub App ID',
    validate: (value) => validatePositiveInteger(value ?? '', 'App ID is required'),
  })
  if (isCancel(appId)) {
    cancel('Aborted.')
    process.exit(0)
  }
  const privateKeyInput = await text({
    message: 'GitHub App private key PEM, escaped PEM, or path to .pem file',
    validate: (value) => (value && value.length > 0 ? undefined : 'Private key is required'),
  })
  if (isCancel(privateKeyInput)) {
    cancel('Aborted.')
    process.exit(0)
  }
  const installationId = await text({
    message: 'Installation ID (optional; leave blank to auto-discover)',
    validate: (value) =>
      value === undefined || value === '' ? undefined : validatePositiveInteger(value, 'Installation ID is required'),
  })
  if (isCancel(installationId)) {
    cancel('Aborted.')
    process.exit(0)
  }
  const parsedInstallationId = installationId === '' ? undefined : Number(installationId)
  return {
    type: 'app',
    appId: Number(appId),
    privateKey: await resolvePrivateKeyInput(privateKeyInput),
    ...(parsedInstallationId !== undefined ? { installationId: parsedInstallationId } : {}),
  }
}

async function resolvePrivateKeyInput(input: string): Promise<string> {
  const normalized = input.replace(/\\n/g, '\n')
  if (normalized.includes('-----BEGIN') && normalized.includes('PRIVATE KEY-----')) return normalized
  return await readFile(input, 'utf8')
}

function parseRepos(input: string): string[] {
  return input
    .split(',')
    .map((v) => v.trim())
    .filter((v) => /^[^\s/]+\/[^\s/]+$/.test(v))
}

function validateUrl(value: string, requiredMessage: string): string | undefined {
  if (!value || value.length === 0) return requiredMessage
  try {
    new URL(value)
    return undefined
  } catch {
    return 'Must be a valid URL'
  }
}

function validatePositiveInteger(value: string, requiredMessage: string): string | undefined {
  if (!value || value.length === 0) return requiredMessage
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? undefined : 'Must be a positive integer'
}

async function promptDiscordToken(): Promise<string> {
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
  return token
}

async function promptSlackTokens(): Promise<{ bot: string; app: string }> {
  printSlackAppManifestSetup()
  const bot = await promptSlackBotToken()
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
  const app = await promptSlackAppToken()
  return { bot, app }
}

async function promptSlackBotToken(): Promise<string> {
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
  return botToken
}

async function promptSlackAppToken(): Promise<string> {
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
  return appToken
}

async function promptTelegramToken(): Promise<string> {
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
  return token
}

async function promptKakaotalkCredentials(
  opts: { defaultEmail?: string } = {},
): Promise<{ email: string; password: string }> {
  note(
    [
      'KakaoTalk authentication uses a personal account, registered as a',
      'tablet sub-device. Messages will be sent and received under this',
      'account. Use a non-primary account if possible.',
      '',
      'On reauth, the existing device_uuid is preserved automatically, so',
      'subsequent logins for the same account typically skip the phone',
      'passcode confirmation.',
    ].join('\n'),
    'About to log in to KakaoTalk',
  )
  const email = await text({
    message: 'KakaoTalk email',
    ...(opts.defaultEmail !== undefined ? { initialValue: opts.defaultEmail, placeholder: opts.defaultEmail } : {}),
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
  return { email, password: pwd }
}

function reportProgress(events: AddChannelStepEvent[]): (event: AddChannelStepEvent) => void {
  const spinners: Partial<Record<AddChannelStepEvent['step'], ReturnType<typeof spinner>>> = {}

  return (event) => {
    events.push(event)
    if (event.phase === 'start') {
      const s = spinner()
      s.start(START_MESSAGES[event.step])
      spinners[event.step] = s
      return
    }

    const s = spinners[event.step]
    if (!s) return

    switch (event.step) {
      case 'kakaotalk-auth':
        s.stop(reportKakaotalkAuth(event.result))
        break
      case 'config':
        s.stop('Updated typeclaw.json.')
        break
      case 'secrets':
        s.stop('Saved credentials to secrets.json.')
        break
      case 'github-webhooks':
        s.stop(formatEagerGithubWebhookInstallResult(event.result))
        break
    }
  }
}

const START_MESSAGES: Record<AddChannelStepEvent['step'], string> = {
  'kakaotalk-auth': 'Logging in to KakaoTalk...',
  config: 'Updating typeclaw.json...',
  secrets: 'Saving credentials to secrets.json...',
  'github-webhooks': 'Installing GitHub repository webhooks...',
}

function reportKakaotalkAuth(result: KakaotalkAuthResult): string {
  if (result.ok) return 'KakaoTalk credentials saved to secrets.json.'
  return `KakaoTalk login failed: ${result.reason}`
}

async function maybePromptRestart(cwd: string, channel: ChannelKind): Promise<void> {
  const label = CHANNEL_LABELS[channel]
  const current = await status({ cwd }).catch(() => null)
  if (current === null || current.kind !== 'running') {
    done({
      title: c.green(`${label} channel added.`),
      hints: [
        { label: 'Start the agent:', command: 'typeclaw start' },
        { label: 'Then check status:', command: 'typeclaw status' },
      ],
    })
    return
  }

  const restartNow = await confirm({
    message:
      'Channel config is restart-required and the agent container is running. Restart it now to apply the new channel?',
    initialValue: true,
  })
  if (isCancel(restartNow) || !restartNow) {
    done({
      title: c.green(`${label} channel added.`),
      hints: [
        { label: 'Apply later:', command: 'typeclaw restart' },
        { label: 'Check status:', command: 'typeclaw status' },
      ],
    })
    return
  }

  const stopped = await stop({ cwd })
  if (!stopped.ok) {
    console.error(errorLine(`Restart failed during stop: ${stopped.reason}`))
    process.exit(1)
  }
  const started = await start({ cwd, preferredHostPort: config.port, cliEntry: process.argv[1] })
  if (!started.ok) {
    console.error(errorLine(`Restart failed during start: ${started.reason}`))
    process.exit(1)
  }
  done({
    title: c.green(`${label} channel added. Restarted ${started.plan.containerName} on host port ${started.hostPort}.`),
    hints: [
      { label: 'Attach TUI:', command: 'typeclaw tui' },
      { label: 'Follow logs:', command: 'typeclaw logs -f' },
    ],
  })
}
