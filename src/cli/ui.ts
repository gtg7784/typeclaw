import { styleText } from 'node:util'

import { cancel, intro, isCancel, log, note, outro, spinner as clackSpinner } from '@clack/prompts'

import { type AutoUpgradeOutcome, describeAutoUpgrade } from '@/init/auto-upgrade'

export { cancel, intro, isCancel, log, note, outro }

function colorize(modifier: Parameters<typeof styleText>[0], s: string): string {
  if (!colorsEnabled()) return s
  return styleText(modifier, s)
}

// Re-evaluated per call so tests can mutate NO_COLOR / FORCE_COLOR between
// cases without stale module-load caching.
function colorsEnabled(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false
  if (process.env.FORCE_COLOR === '0') return false
  if (process.env.FORCE_COLOR) return true
  return Boolean(process.stdout.isTTY)
}

export const c = {
  cyan: (s: string) => colorize('cyan', s),
  green: (s: string) => colorize('green', s),
  red: (s: string) => colorize('red', s),
  yellow: (s: string) => colorize('yellow', s),
  dim: (s: string) => colorize('dim', s),
  gray: (s: string) => colorize('gray', s),
  magenta: (s: string) => colorize('magenta', s),
  bold: (s: string) => colorize('bold', s),
}

// OSC 8 hyperlink with plain fallback when colors are off so piped output
// and non-OSC-8 terminals stay readable.
export function link(text: string, url: string): string {
  if (!colorsEnabled()) return `${text} (${url})`
  return `\u001b]8;;${url}\u0007${text}\u001b]8;;\u0007`
}

export type Spinner = {
  start: (msg?: string) => void
  stop: (msg?: string) => void
  error: (msg?: string) => void
  cancel: (msg?: string) => void
  message: (msg?: string) => void
}

export function spinner(): Spinner {
  const s = clackSpinner()
  return {
    start: (msg) => s.start(msg),
    stop: (msg) => s.stop(msg),
    error: (msg) => s.error(msg),
    cancel: (msg) => s.cancel(msg),
    message: (msg) => s.message(msg),
  }
}

export type StartLikeResult = {
  alreadyRunning?: boolean
  built: boolean
  plan: { containerName: string; imageTag: string }
  hostPort: number
  containerId: string
  hostd: { state: 'registered' } | { state: 'unavailable'; reason: string } | { state: 'disabled' }
  autoUpgrade?: AutoUpgradeOutcome
}

export function renderStartSuccess(result: StartLikeResult): string {
  const lines: string[] = []
  const name = c.cyan(result.plan.containerName)
  const port = c.green(String(result.hostPort))

  if (result.autoUpgrade) {
    const message = describeAutoUpgrade(result.autoUpgrade)
    if (message.length > 0) {
      const tint = result.autoUpgrade.kind === 'exact-pin-respected' ? c.yellow : c.cyan
      lines.push(tint(message))
    }
  }

  if (result.alreadyRunning) {
    lines.push(`${c.green('●')} ${name} is already running on host port ${port}.`)
  } else {
    if (result.built) {
      lines.push(`Built image ${c.cyan(result.plan.imageTag)}.`)
    }
    const shortId = result.containerId.slice(0, 12)
    lines.push(`${c.green('●')} ${name} started on host port ${port} ${c.dim(`(${shortId})`)}.`)
  }

  if (result.hostd.state === 'registered') {
    lines.push(c.dim('Host daemon active.'))
  } else if (result.hostd.state === 'unavailable') {
    lines.push(`${c.yellow('Host daemon unavailable:')} ${result.hostd.reason}`)
  }

  lines.push('')
  lines.push(`${c.dim('Follow logs:')}  ${c.cyan('typeclaw logs -f')}`)
  lines.push(`${c.dim('Attach TUI:')}   ${c.cyan('typeclaw tui')}`)
  lines.push(`${c.dim('Stop:')}         ${c.cyan('typeclaw stop')}`)

  return lines.join('\n')
}

export type NextStepHint = { label: string; command: string }

// `details` goes into the body, not the title: clack's `note()` sizes the
// box to the title's visual width and never wraps titles, so a long title
// breaks the layout on narrow terminals. Body content is wrapped to fit.
export function done(opts: { title: string; details?: string; hints: NextStepHint[] }): void {
  const lines: string[] = []
  if (opts.details !== undefined && opts.details !== '') lines.push(opts.details)
  for (const h of opts.hints) lines.push(`${c.dim(h.label)}  ${c.cyan(h.command)}`)
  note(lines.join('\n'), opts.title)
  outro(c.green('Done.'))
}

export function errorLine(reason: string): string {
  return `${c.red('✖')} ${reason}`
}

export function successLine(message: string): string {
  return `${c.green('●')} ${message}`
}

// The exact JSON manifest a user pastes into
// https://api.slack.com/apps → From a manifest. Kept as a typed object so
// the file stays a single source of truth and `JSON.stringify` guarantees
// the rendered text is always valid JSON — no risk of a stray comma or
// quote slipping in through hand-formatting.
export const SLACK_APP_MANIFEST = {
  display_information: { name: 'TypeClaw' },
  features: {
    bot_user: { display_name: 'TypeClaw', always_online: true },
    // Enable the Messages tab so users can DM the bot from its app profile,
    // and disable the Home tab — TypeClaw does not publish a custom App Home
    // view, and leaving it enabled would surface an empty default tab.
    app_home: {
      home_tab_enabled: false,
      messages_tab_enabled: true,
      messages_tab_read_only_enabled: false,
    },
    // Slash commands listed here appear in Slack's compose-box picker with
    // their description as a tooltip. `url` is required by Slack's manifest
    // schema even for Socket Mode bots, but is ignored at runtime when the
    // app is in Socket Mode — Slack delivers `slash_commands` envelopes
    // over the same WebSocket as message events. We point it at a
    // deliberately-invalid placeholder (RFC 6761 reserved .invalid TLD)
    // so a misconfigured (non-Socket-Mode) deployment fails fast rather
    // than silently routing real slash invocations to a third-party URL.
    slash_commands: [
      {
        command: '/stop',
        description: 'Abort the current turn in this channel',
        // usage_hint is intentionally omitted. Slack's manifest validator
        // rejects an empty string ("Must be more than 0 characters") but
        // the field is optional, so the cleanest answer is to leave it out
        // rather than invent placeholder text for a command that takes no
        // arguments.
        url: 'https://example.invalid/typeclaw-uses-socket-mode',
        should_escape: false,
      },
    ],
  },
  oauth_config: {
    scopes: {
      // Ordered alphabetically so the manifest stays a stable diff target.
      // Read scopes cover every conversation type the agent might observe;
      // write scopes (chat, files, im/mpim/groups, pins, reactions) let the
      // agent post replies, upload attachments, open DMs, pin messages, and
      // react to messages. `channels:join` lets the bot self-join public
      // channels it's invited to discuss in. `commands` is required for
      // Slack to deliver `slash_commands` envelopes — without it, slash
      // commands registered in `features` would silently fail to route.
      bot: [
        'app_mentions:read',
        'channels:history',
        'channels:join',
        'channels:read',
        'chat:write',
        'commands',
        'emoji:read',
        'files:read',
        'files:write',
        'groups:history',
        'groups:read',
        'groups:write',
        'im:history',
        'im:read',
        'im:write',
        'mpim:history',
        'mpim:read',
        'mpim:write',
        'pins:read',
        'pins:write',
        'reactions:read',
        'reactions:write',
        'users:read',
      ],
    },
  },
  settings: {
    event_subscriptions: {
      bot_events: ['app_mention', 'message.channels', 'message.groups', 'message.im', 'message.mpim'],
    },
    socket_mode_enabled: true,
  },
} as const

// Prints the "create a Slack app from a manifest" walkthrough so the JSON
// payload is **flush-left and copy-pasteable**. Clack's `note()` wraps
// content inside a box with `│` borders on both sides, and `log.message()`
// still prefixes every line with a `│  ` guide column — neither survives a
// click-and-drag copy. This helper splits the walkthrough into three
// segments: a boxed prose intro, a raw-stdout JSON block, and a boxed
// follow-up. The JSON block is emitted via `process.stdout.write` so it
// carries zero terminal decoration.
export function printSlackAppManifestSetup(output: NodeJS.WritableStream = process.stdout): void {
  note(
    [
      '1. https://api.slack.com/apps → Create New App → From a manifest.',
      '   Pick your workspace, then paste the JSON manifest printed below',
      `   (it is rendered flush-left so you can ${c.bold('click-drag and copy')} cleanly).`,
    ].join('\n'),
    'Get a Slack bot',
  )
  output.write('\n')
  output.write(`${JSON.stringify(SLACK_APP_MANIFEST, null, 2)}\n`)
  output.write('\n')
  note(
    [
      '2. Install to Workspace, then OAuth & Permissions →',
      '   copy the Bot User OAuth Token (xoxb-...).',
      '3. Basic Information → App-Level Tokens → Generate Token and',
      '   Scopes, add the connections:write scope, and copy the',
      '   token (xapp-...). Socket Mode needs this; the manifest',
      '   cannot grant it.',
      '4. Invite the bot to any private channel or DM you want it in:',
      '   /invite @TypeClaw',
    ].join('\n'),
    'Finish Slack setup',
  )
}
