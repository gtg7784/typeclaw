import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { config, configSchema, type Config } from '@/config'
import { DEFAULT_MODEL_REF, KNOWN_PROVIDERS, providerForModelRef, type KnownModelRef } from '@/config/providers'
import { checkDockerAvailable, type DockerAvailability, type DockerExec, start } from '@/container'
import { SecretsBackend } from '@/secrets'
import { createTui } from '@/tui'

import { resolveBaseImageVersion, resolveScaffoldVersion } from './cli-version'
import { buildDockerfile, DOCKERFILE } from './dockerfile'
import { buildGitignore, GITIGNORE_FILE } from './gitignore'
import { HATCHING_PROMPT } from './hatching'
import type { OAuthLoginRunner, OAuthLoginResult } from './oauth-login'
import { GITKEEP_FILE, PACKAGES_DIR } from './paths'
import { type InstallResult, type InstallRunner, runBunInstall } from './run-bun-install'

export { type InstallResult, type InstallRunner, runBunInstall } from './run-bun-install'

export { GITKEEP_FILE, PACKAGES_DIR } from './paths'

const CONFIG_FILE = 'typeclaw.json'
const CRON_FILE = 'cron.json'
const SECRETS_FILE = '.env'
const PACKAGE_FILE = 'package.json'

const MARKDOWN_FILES = ['AGENTS.md', 'IDENTITY.md', 'SOUL.md', 'USER.md'] as const

// `packages/` is a bun workspace root (see `workspaces` in buildPackageJson).
// Reusable systems the agent builds — including custom plugins wired into
// typeclaw.json — live there as standalone packages, while one-off scripts
// stay in `workspace/`. The directory is scaffolded empty so the layout is
// discoverable on day one; a `.gitkeep` is written below so it survives the
// initial commit.
const DIRECTORIES = ['workspace', 'sessions', '.agents/skills', 'mounts', 'packages'] as const

export type GitInitResult = { ok: true; skipped: boolean } | { ok: false; reason: string }
export type DockerAssetsResult = { ok: true; devMode: boolean } | { ok: false; reason: string }
export type HatchingResult = { ok: true } | { ok: false; reason: string }

export type InitStep =
  | 'preflight'
  | 'oauth-login'
  | 'scaffold'
  | 'kakaotalk-auth'
  | 'install'
  | 'dockerfile'
  | 'git'
  | 'hatching'

export type KakaotalkAuthResult = { ok: true } | { ok: false; reason: string }

export type InitStepEvent =
  | { step: 'preflight'; phase: 'start' }
  | { step: 'preflight'; phase: 'done'; result: DockerAvailability }
  | { step: 'oauth-login'; phase: 'start' }
  | { step: 'oauth-login'; phase: 'done'; result: OAuthLoginResult }
  | { step: 'scaffold'; phase: 'start' }
  | { step: 'scaffold'; phase: 'done' }
  | { step: 'kakaotalk-auth'; phase: 'start' }
  | { step: 'kakaotalk-auth'; phase: 'done'; result: KakaotalkAuthResult }
  | { step: 'install'; phase: 'start' }
  | { step: 'install'; phase: 'done'; result: InstallResult }
  | { step: 'dockerfile'; phase: 'start' }
  | { step: 'dockerfile'; phase: 'done'; result: DockerAssetsResult }
  | { step: 'git'; phase: 'start' }
  | { step: 'git'; phase: 'done'; result: GitInitResult }
  | { step: 'hatching'; phase: 'start' }
  | { step: 'hatching'; phase: 'done'; result: HatchingResult }

// `cliEntry` is the path to the running CLI module (typically `process.argv[1]`).
// When provided, the hatching step threads it into `start()`, which spawns the
// host daemon and registers the freshly-hatched container with the supervisor +
// portbroker — same path `typeclaw start` takes. When omitted (test fixtures,
// programmatic callers that never want a daemon), `start()` skips the daemon
// path entirely and the container runs unmanaged.
export type HatchRunner = (options: { cwd: string; port: number; cliEntry?: string }) => Promise<HatchingResult>

export type KakaotalkAuthRunner = (options: { cwd: string }) => Promise<KakaotalkAuthResult>

// Discriminated by `kind` so the type system enforces "you can't pass an
// API key to an OAuth provider, and you can't pass an OAuth runner to an
// API-key provider". Optional model defaults to DEFAULT_MODEL_REF, which is
// an OpenAI api-key provider — so test fixtures that omit both fields keep
// working under the api-key path.
export type LLMAuth = { kind: 'api-key'; apiKey: string } | { kind: 'oauth'; runLogin: OAuthLoginRunner }

export type InitOptions = {
  cwd: string
  // Selected `provider/model` ref written into typeclaw.json. Defaults to
  // DEFAULT_MODEL_REF when callers (or older test fixtures) omit it.
  model?: KnownModelRef
  // How the agent will authenticate to the LLM provider. When omitted,
  // defaults to the api-key path with `apiKey` (legacy field, still
  // supported for backwards compat with the old `runInit` signature).
  llmAuth?: LLMAuth
  apiKey?: string
  discordBotToken?: string
  discordAllowAll?: boolean
  slackBotToken?: string
  slackAppToken?: string
  slackAllowAll?: boolean
  telegramBotToken?: string
  telegramAllowAll?: boolean
  withKakaotalk?: boolean
  kakaotalkAllowAll?: boolean
  runKakaotalkAuth?: KakaotalkAuthRunner
  onProgress?: (event: InitStepEvent) => void
  runHatching?: HatchRunner
  runBunInstall?: InstallRunner
  dockerExec?: DockerExec
  // Production CLI callers (src/cli/init.ts) pass `process.argv[1]` so the
  // hatching step's `start()` call spawns the host daemon and registers the
  // freshly-hatched container — same path `typeclaw start` takes. Tests omit
  // this to skip the daemon entirely (matching the existing seam in
  // src/container/start.ts).
  cliEntry?: string
}

export async function runInit({
  cwd,
  apiKey,
  llmAuth,
  model = DEFAULT_MODEL_REF,
  discordBotToken,
  discordAllowAll = true,
  slackBotToken,
  slackAppToken,
  slackAllowAll = true,
  telegramBotToken,
  telegramAllowAll = true,
  withKakaotalk = false,
  kakaotalkAllowAll = false,
  runKakaotalkAuth,
  onProgress,
  runHatching = defaultRunHatching,
  runBunInstall: installRunner = runBunInstall,
  dockerExec,
  cliEntry,
}: InitOptions): Promise<void> {
  const emit = onProgress ?? (() => {})

  // Docker preflight runs BEFORE any scaffolding so a missing-binary or
  // daemon-down failure leaves the user's directory untouched. Without this
  // gate, init would lay the egg, write the Dockerfile, init git, and then
  // fail at hatching with a raw "Executable not found in $PATH: docker" —
  // leaving a half-initialized agent folder the user has to clean up by hand.
  emit({ step: 'preflight', phase: 'start' })
  const preflight = await checkDockerAvailable(dockerExec)
  emit({ step: 'preflight', phase: 'done', result: preflight })
  if (!preflight.ok) return

  // Resolve the auth contract: explicit `llmAuth` wins; otherwise, fall back
  // to the legacy `apiKey` field (api-key path). Throwing here instead of
  // proceeding with bad data prevents writing a half-initialized agent
  // folder for a doomed config.
  const resolvedAuth = resolveLLMAuth(llmAuth, apiKey)

  // OAuth login runs BEFORE scaffold so a failed/aborted browser flow leaves
  // the user's directory untouched (same rationale as the docker preflight).
  // Same trap as kakaotalk-auth: scaffold-then-fail-auth would leave
  // typeclaw.json without working credentials and the runtime would silently
  // refuse to boot. The login itself doesn't need the agent folder to exist
  // — pi-ai's OAuth helper just needs a writable path for secrets.json, which
  // we create on demand inside scaffold().
  if (resolvedAuth.kind === 'oauth') {
    emit({ step: 'oauth-login', phase: 'start' })
    await mkdir(cwd, { recursive: true })
    const result = await resolvedAuth.runLogin({ cwd, model })
    emit({ step: 'oauth-login', phase: 'done', result })
    if (!result.ok) {
      throw new Error(`OAuth login failed: ${result.reason}`)
    }
  }

  const wantsDiscord = discordBotToken !== undefined && discordBotToken !== ''
  const wantsSlack = slackBotToken !== undefined && slackBotToken !== ''
  const wantsTelegram = telegramBotToken !== undefined && telegramBotToken !== ''
  emit({ step: 'scaffold', phase: 'start' })
  await scaffold(cwd, {
    model,
    withDiscord: wantsDiscord,
    discordAllowAll,
    withSlack: wantsSlack,
    slackAllowAll,
    withTelegram: wantsTelegram,
    telegramAllowAll,
    withKakaotalk,
    kakaotalkAllowAll,
  })
  // Only write the LLM API key on the api-key path. OAuth providers persist
  // their credentials to secrets.json (via the OAuth login step above); writing
  // an empty FIREWORKS_API_KEY/OPENAI_API_KEY would just confuse users.
  await writeSecrets(cwd, {
    model,
    apiKey: resolvedAuth.kind === 'api-key' ? resolvedAuth.apiKey : undefined,
    discordBotToken,
    slackBotToken,
    slackAppToken,
    telegramBotToken,
  })
  emit({ step: 'scaffold', phase: 'done' })

  if (withKakaotalk && runKakaotalkAuth !== undefined) {
    emit({ step: 'kakaotalk-auth', phase: 'start' })
    const result = await runKakaotalkAuth({ cwd })
    emit({ step: 'kakaotalk-auth', phase: 'done', result })
    if (!result.ok) {
      // Abort the rest of the pipeline. Continuing would leave the agent
      // folder with `channels.kakaotalk` in typeclaw.json but no credentials
      // file, which `typeclaw start` later treats as "missing credentials,
      // skip adapter" — confusing the user about whether KakaoTalk works.
      // The user can re-run `typeclaw init` after fixing the auth issue;
      // the scaffold/Dockerfile work above is idempotent.
      throw new Error(`KakaoTalk authentication failed: ${result.reason}`)
    }
  }

  emit({ step: 'install', phase: 'start' })
  const install = await installRunner(cwd)
  emit({ step: 'install', phase: 'done', result: install })

  emit({ step: 'dockerfile', phase: 'start' })
  const docker = await writeDockerAssets(cwd)
  emit({ step: 'dockerfile', phase: 'done', result: docker })

  emit({ step: 'git', phase: 'start' })
  const git = await initGitRepo(cwd)
  emit({ step: 'git', phase: 'done', result: git })

  emit({ step: 'hatching', phase: 'start' })
  const hatching = await runHatching({ cwd, port: config.port, ...(cliEntry !== undefined ? { cliEntry } : {}) })
  emit({ step: 'hatching', phase: 'done', result: hatching })
}

// Exported for the composition test in index.test.ts: the seam that the
// hatching-hostd fix turns on (passing `cliEntry` into `start()`) is the bug
// site itself, so a guard test that proves `defaultRunHatching` forwards
// `cliEntry` to `start()` is what blocks the regression from coming back.
// Tests inject `startContainer` and `tui` to avoid Docker / TUI side effects;
// production callers omit both and get the real `start` + `createTui`.
export async function defaultRunHatching({
  cwd,
  port,
  cliEntry,
  startContainer = start,
  tui: tuiFactory = createTui,
  waitForAgent: waitForAgentFn = waitForAgent,
}: {
  cwd: string
  port: number
  cliEntry?: string
  startContainer?: typeof start
  tui?: typeof createTui
  waitForAgent?: typeof waitForAgent
}): Promise<HatchingResult> {
  try {
    const launch = await startContainer({
      cwd,
      preferredHostPort: port,
      ...(cliEntry !== undefined ? { cliEntry } : {}),
    })
    if (!launch.ok) return { ok: false, reason: launch.reason }

    // start() may have allocated a different host port (the preferred one was
    // bound). Use the actually-published port for the TUI handshake instead of
    // the preferred port, otherwise we'd connect to the wrong service.
    const hostPort = launch.hostPort

    await waitForAgentFn(`http://localhost:${hostPort}`, { timeoutMs: 30_000 })

    const tui = tuiFactory({
      url: `ws://localhost:${hostPort}`,
      initialPrompt: HATCHING_PROMPT,
    })
    await tui.run()
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

// Probe the server's plain HTTP fallback (non-upgrade requests get a 200 with
// body "typeclaw agent") instead of opening a WebSocket. Opening a WS here
// would trigger createSession on the server and burn an LLM session just to
// learn the port is up.
async function waitForAgent(httpUrl: string, { timeoutMs }: { timeoutMs: number }): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const res = await fetch(httpUrl)
      if (res.status === 200) return
      lastError = new Error(`unexpected status ${res.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`timed out waiting for agent at ${httpUrl}: ${lastError instanceof Error ? lastError.message : ''}`)
}

export function isDirectoryNonEmpty(dir: string): boolean {
  try {
    return readdirSync(dir).some((entry) => !entry.startsWith('.'))
  } catch {
    return false
  }
}

export function isInitialized(dir: string): boolean {
  return existsSync(join(dir, CONFIG_FILE))
}

// Walks upward from `start` looking for the agent folder (the dir containing
// typeclaw.json). Returns the found dir, or null if nothing is found before
// the walk hits a stop boundary.
//
// Stop boundaries (whichever comes first, checked at every level):
//   1. The current dir contains typeclaw.json — return it.
//   2. The current dir contains .git — return null. A .git boundary marks a
//      project root; refusing to cross it prevents accidentally picking up an
//      unrelated parent project, and matches how typeclaw itself initializes
//      one .git per agent folder.
//   3. We've reached the filesystem root — return null.
//
// The `.git` check fires AFTER the typeclaw.json check at the same level so
// that walking up from a subdir of the agent (e.g. `<agent>/workspace/`) still
// resolves to the agent root, even though the agent root itself contains both
// typeclaw.json and .git.
export function findAgentDir(start: string): string | null {
  let dir = resolve(start)
  const root = resolve(dir, '/')
  while (true) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir
    if (existsSync(join(dir, '.git'))) return null
    if (dir === root) return null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

const HATCHED_COMMIT_SUBJECT = 'Hatched 🐣'

export async function isHatched(dir: string): Promise<boolean> {
  if (!existsSync(join(dir, '.git'))) return false
  const bun = (globalThis as { Bun?: { spawn: typeof Bun.spawn } }).Bun
  if (!bun) return false
  try {
    const proc = bun.spawn({ cmd: ['git', 'log', '--format=%s'], cwd: dir, stdout: 'pipe', stderr: 'pipe' })
    if ((await proc.exited) !== 0) return false
    const subjects = (await new Response(proc.stdout).text()).split('\n')
    return subjects.includes(HATCHED_COMMIT_SUBJECT)
  } catch {
    return false
  }
}

export type ScaffoldOptions = {
  model?: KnownModelRef
  withDiscord?: boolean
  discordAllowAll?: boolean
  withSlack?: boolean
  slackAllowAll?: boolean
  withTelegram?: boolean
  telegramAllowAll?: boolean
  withKakaotalk?: boolean
  kakaotalkAllowAll?: boolean
}

export async function scaffold(root: string, options: ScaffoldOptions = {}): Promise<void> {
  await Promise.all(DIRECTORIES.map((dir) => mkdir(join(root, dir), { recursive: true })))

  // git does not track empty directories, so without this file the `packages/`
  // workspace root would silently disappear from the initial commit and confuse
  // the agent (its workspaces glob would resolve to nothing). The other
  // DIRECTORIES are either gitignored (workspace, sessions, mounts) or
  // immediately populated, so packages/ is the only one that needs this.
  await writeFile(join(root, PACKAGES_DIR, GITKEEP_FILE), '', { flag: 'wx' }).catch(ignoreExists)

  // Only fields without sensible defaults elsewhere are emitted, with one
  // exception: `network.blockInternal` is re-emitted at its default value
  // (`true`) because the field is security-relevant and users need to
  // discover it in their `typeclaw.json` to know they can opt out for LAN
  // access. `mounts` defaults to `[]` in configSchema, and the bundled
  // memory plugin owns its own defaults in src/bundled-plugins/memory/
  // index.ts — re-emitting either here would be duplicate noise the user
  // has to maintain in sync with the source of truth.
  const config: Record<string, unknown> = {
    $schema: './node_modules/typeclaw/typeclaw.schema.json',
    model: options.model ?? DEFAULT_MODEL_REF,
    network: { blockInternal: true },
  }
  const channels: Record<string, { allow: string[] }> = {}
  if (options.withDiscord) channels['discord-bot'] = { allow: options.discordAllowAll === false ? [] : ['*'] }
  if (options.withSlack) channels['slack-bot'] = { allow: options.slackAllowAll === false ? [] : ['*'] }
  if (options.withTelegram) channels['telegram-bot'] = { allow: options.telegramAllowAll === false ? [] : ['*'] }
  if (options.withKakaotalk) {
    // KakaoTalk involves a personal account, so we default to a tighter
    // allow list (DMs only) than Slack/Discord/Telegram which scope to a
    // workspace the user explicitly admitted the bot into. The user can
    // broaden to `kakao:*` later by editing typeclaw.json.
    channels.kakaotalk = { allow: options.kakaotalkAllowAll === true ? ['kakao:*'] : ['kakao:dm/*'] }
  }
  if (Object.keys(channels).length > 0) config.channels = channels
  await writeFile(join(root, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`)

  const cron = {
    $schema: './node_modules/typeclaw/cron.schema.json',
    jobs: [],
  }
  await writeFile(join(root, CRON_FILE), `${JSON.stringify(cron, null, 2)}\n`, { flag: 'wx' }).catch(ignoreExists)

  const pkg = buildPackageJson(root, basename(root))
  await writeFile(join(root, PACKAGE_FILE), `${JSON.stringify(pkg, null, 2)}\n`, { flag: 'wx' }).catch(ignoreExists)

  await Promise.all(MARKDOWN_FILES.map((file) => writeFile(join(root, file), '', { flag: 'wx' }).catch(ignoreExists)))

  await writeFile(join(root, GITIGNORE_FILE), buildGitignore(), { flag: 'wx' }).catch(ignoreExists)
}

// agent-browser ships in every agent: the bundled SKILL.md (src/skills/
// agent-browser/SKILL.md) is a discovery stub that calls `agent-browser
// skills get core` at runtime, so the CLI must be installed for the skill
// to function. The Dockerfile pre-downloads Chromium too, so the agent
// can drive a browser without any first-run setup.
const AGENT_BROWSER_VERSION = '^0.26.0'

function buildPackageJson(root: string, name: string): Record<string, unknown> {
  return {
    name,
    private: true,
    type: 'module',
    workspaces: [`${PACKAGES_DIR}/*`],
    dependencies: {
      typeclaw: resolveTypeclawSpec(root),
      'agent-browser': AGENT_BROWSER_VERSION,
    },
  }
}

// Prefer the registry-style range (`^X.Y.Z`) when typeclaw is itself an
// installed package — that's what lets `bun install` in the agent resolve
// typeclaw from npm. Fall back to `file:` against the local checkout for
// dev contributors running `bun run src/cli/index.ts init` from the repo.
function resolveTypeclawSpec(agentRoot: string): string {
  const scaffoldVersion = resolveScaffoldVersion()
  if (scaffoldVersion !== null) return scaffoldVersion
  const typeclawRoot = findTypeclawRoot()
  return typeclawRoot ? `file:${toFileSpec(relative(agentRoot, typeclawRoot))}` : 'file:../typeclaw'
}

function toFileSpec(rel: string): string {
  if (rel === '') return '.'
  // bun/npm accept POSIX-style paths in file: specifiers; normalize separators.
  return rel.split(/[\\/]/).join('/')
}

function findTypeclawRoot(): string | null {
  try {
    let dir = dirname(fileURLToPath(import.meta.url))
    const root = resolve('/')
    while (dir !== root) {
      const pkgPath = join(dir, 'package.json')
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string }
        if (pkg.name === 'typeclaw') return dir
      }
      dir = dirname(dir)
    }
  } catch {}
  return null
}

export async function writeDockerAssets(root: string): Promise<DockerAssetsResult> {
  try {
    const pkg = await readPackageJson(root)
    const typeclawSpec = pkg.dependencies?.typeclaw ?? ''
    const devMode = typeclawSpec.startsWith('file:')

    const typeclawConfig = await readTypeclawConfig(root)
    await writeFile(
      join(root, DOCKERFILE),
      buildDockerfile(typeclawConfig.dockerfile, { baseImageVersion: resolveBaseImageVersion(root) }),
      { flag: 'wx' },
    ).catch(ignoreExists)

    return { ok: true, devMode }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

async function readPackageJson(root: string): Promise<{ name?: string; dependencies?: Record<string, string> }> {
  const raw = await readFile(join(root, PACKAGE_FILE), 'utf8')
  return JSON.parse(raw) as { name?: string; dependencies?: Record<string, string> }
}

async function readTypeclawConfig(root: string): Promise<Config> {
  try {
    const raw = await readFile(join(root, CONFIG_FILE), 'utf8')
    return configSchema.parse(JSON.parse(raw))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return configSchema.parse({})
    throw error
  }
}

export async function initGitRepo(cwd: string): Promise<GitInitResult> {
  const bun = (globalThis as { Bun?: { spawn: typeof Bun.spawn } }).Bun
  if (!bun) return { ok: false, reason: 'bun runtime not available' }

  if (existsSync(join(cwd, '.git'))) return { ok: true, skipped: true }

  // Author the initial commit as TypeClaw itself. The agent is still unnamed
  // (IDENTITY.md is empty and hatching hasn't run), so the agent identity will
  // take over from the hatching commit onward. This also avoids depending on
  // the user's global `user.name`/`user.email`.
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'TypeClaw',
    GIT_AUTHOR_EMAIL: 'hello@typeclaw.dev',
    GIT_COMMITTER_NAME: 'TypeClaw',
    GIT_COMMITTER_EMAIL: 'hello@typeclaw.dev',
  }

  try {
    const init = bun.spawn({ cmd: ['git', 'init', '-b', 'main'], cwd, env, stdout: 'pipe', stderr: 'pipe' })
    if ((await init.exited) !== 0) {
      const stderr = await new Response(init.stderr).text()
      return { ok: false, reason: `git init failed: ${stderr.trim() || 'no stderr'}` }
    }

    const add = bun.spawn({ cmd: ['git', 'add', '.'], cwd, env, stdout: 'pipe', stderr: 'pipe' })
    if ((await add.exited) !== 0) {
      const stderr = await new Response(add.stderr).text()
      return { ok: false, reason: `git add failed: ${stderr.trim() || 'no stderr'}` }
    }

    const commit = bun.spawn({
      cmd: ['git', 'commit', '-m', 'Initial commit 🥚'],
      cwd,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if ((await commit.exited) !== 0) {
      const stderr = await new Response(commit.stderr).text()
      return { ok: false, reason: `git commit failed: ${stderr.trim() || 'no stderr'}` }
    }

    return { ok: true, skipped: false }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

// Writes the LLM provider's API key to `.env` (under its provider-specific
// env var, e.g. OPENAI_API_KEY or FIREWORKS_API_KEY) and the channel adapter
// tokens to `secrets.json#channels`. Two stores on purpose: the api-key flows
// through .env to keep parity with the existing `--env-file .env` boot
// contract (the runtime promotes it into secrets.json on first read, see
// `src/agent/auth.ts`); channel tokens skip the .env hop entirely and land
// in secrets.json directly because that's the only file the runtime needs to
// see (it hydrates process.env from there at boot, see
// `src/secrets/hydrate.ts`). Keeps secrets.json as the on-disk source of
// truth for adapter credentials from day one.
export async function writeSecrets(
  root: string,
  {
    model = DEFAULT_MODEL_REF,
    apiKey,
    discordBotToken,
    slackBotToken,
    slackAppToken,
    telegramBotToken,
  }: {
    model?: KnownModelRef
    // Omitted on the OAuth path — credentials live in secrets.json instead.
    // The .env file still gets written (empty) so post-init callers that
    // read it don't ENOENT-crash.
    apiKey?: string
    discordBotToken?: string
    slackBotToken?: string
    slackAppToken?: string
    telegramBotToken?: string
  },
): Promise<void> {
  const providerId = providerForModelRef(model)
  const apiKeyEnv = KNOWN_PROVIDERS[providerId].apiKeyEnv
  const lines: string[] = []
  if (apiKey !== undefined && apiKeyEnv !== null) {
    lines.push(`${apiKeyEnv}=${apiKey}`)
  }
  const body = lines.length > 0 ? `${lines.join('\n')}\n` : ''
  await writeFile(join(root, SECRETS_FILE), body)

  const channelTokens: Record<string, Record<string, string>> = {}
  if (discordBotToken !== undefined && discordBotToken !== '') {
    channelTokens['discord-bot'] = { DISCORD_BOT_TOKEN: discordBotToken }
  }
  if (slackBotToken !== undefined && slackBotToken !== '') {
    channelTokens['slack-bot'] = { ...channelTokens['slack-bot'], SLACK_BOT_TOKEN: slackBotToken }
  }
  if (slackAppToken !== undefined && slackAppToken !== '') {
    channelTokens['slack-bot'] = { ...channelTokens['slack-bot'], SLACK_APP_TOKEN: slackAppToken }
  }
  if (telegramBotToken !== undefined && telegramBotToken !== '') {
    channelTokens['telegram-bot'] = { TELEGRAM_BOT_TOKEN: telegramBotToken }
  }
  if (Object.keys(channelTokens).length === 0) return

  const backend = new SecretsBackend(join(root, 'secrets.json'))
  const existing = backend.readChannelsSync()
  for (const [adapterId, tokens] of Object.entries(channelTokens)) {
    const slot = isStringRecord(existing[adapterId]) ? { ...(existing[adapterId] as Record<string, string>) } : {}
    for (const [k, v] of Object.entries(tokens)) slot[k] = v
    existing[adapterId] = slot
  }
  backend.writeChannelsSync(existing)
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  for (const v of Object.values(value)) {
    if (typeof v !== 'string') return false
  }
  return true
}

function resolveLLMAuth(llmAuth: LLMAuth | undefined, apiKey: string | undefined): LLMAuth {
  if (llmAuth) return llmAuth
  if (apiKey !== undefined) return { kind: 'api-key', apiKey }
  throw new Error('runInit requires either `llmAuth` or `apiKey`')
}

function ignoreExists(error: NodeJS.ErrnoException): void {
  if (error.code !== 'EEXIST') throw error
}

// ----------------------------------------------------------------------------
// `typeclaw channel add`
//
// `runAddChannel` is the post-init counterpart to `runInit`'s channel-related
// steps. It is intentionally a separate pipeline rather than a mode switch on
// `runInit` because the two have opposite file semantics:
//
//   - `runInit` creates a fresh agent folder. Writes overwrite by design
//     (typeclaw.json, .env), and idempotency comes from `wx`-flag guards on
//     never-rewritten files (markdown stubs, cron.json, package.json).
//
//   - `runAddChannel` mutates an already-initialized agent folder. It MUST
//     preserve the user's existing channel config and existing .env values.
//     The only writes are an additive merge of one new channel adapter and
//     an append of that adapter's env vars.
//
// Sharing one function would pile mode flags on every helper and turn the
// "is this overwrite or merge?" question into a runtime branch the test
// suite would have to cover for both behaviors. The mass of independent
// scaffold-test cases above demonstrates how easy it is to lose a single
// behavior under a mode flag.

export type ChannelKind = 'discord-bot' | 'slack-bot' | 'telegram-bot' | 'kakaotalk'

// Public adapter names match the typeclaw.json `channels.*` keys exactly.
// The CLI takes these as the optional positional arg, the picker shows
// these labels, and they're the keys we use to detect "already configured"
// when reading typeclaw.json.
export const CHANNEL_KINDS: ReadonlyArray<ChannelKind> = ['slack-bot', 'discord-bot', 'telegram-bot', 'kakaotalk']

export type AddChannelStep = 'kakaotalk-auth' | 'config' | 'secrets'

export type AddChannelStepEvent =
  | { step: 'config'; phase: 'start' }
  | { step: 'config'; phase: 'done' }
  | { step: 'kakaotalk-auth'; phase: 'start' }
  | { step: 'kakaotalk-auth'; phase: 'done'; result: KakaotalkAuthResult }
  | { step: 'secrets'; phase: 'start' }
  | { step: 'secrets'; phase: 'done' }

// Discriminated union per channel so the type system enforces "you must pass
// the right credentials for the channel you're adding". The CLI builds these
// from prompts; tests build them inline.
export type AddChannelOptions = {
  cwd: string
  allowAll?: boolean
  onProgress?: (event: AddChannelStepEvent) => void
} & (
  | { channel: 'discord-bot'; discordBotToken: string }
  | { channel: 'slack-bot'; slackBotToken: string; slackAppToken: string }
  | { channel: 'telegram-bot'; telegramBotToken: string }
  | { channel: 'kakaotalk'; runKakaotalkAuth: KakaotalkAuthRunner }
)

export async function runAddChannel(options: AddChannelOptions): Promise<void> {
  const emit = options.onProgress ?? (() => {})

  // Order: kakaotalk-auth (if applicable) -> config -> secrets.
  //
  // We run KakaoTalk auth FIRST so a failed login leaves typeclaw.json and
  // .env untouched. The runtime treats `channels.kakaotalk` without a
  // credentials file as "missing credentials, skip adapter", which silently
  // drops messages — the same trap `runInit` already guards against. Aborting
  // before any file write means the user's next `typeclaw channel add
  // kakaotalk` retry has no half-applied state to clean up.
  if (options.channel === 'kakaotalk') {
    emit({ step: 'kakaotalk-auth', phase: 'start' })
    const result = await options.runKakaotalkAuth({ cwd: options.cwd })
    emit({ step: 'kakaotalk-auth', phase: 'done', result })
    if (!result.ok) throw new Error(`KakaoTalk authentication failed: ${result.reason}`)
  }

  emit({ step: 'config', phase: 'start' })
  await mergeChannelIntoConfig(options.cwd, options.channel, options.allowAll ?? defaultAllowAll(options.channel))
  emit({ step: 'config', phase: 'done' })

  emit({ step: 'secrets', phase: 'start' })
  const tokens = channelSecretsFromOptions(options)
  if (Object.keys(tokens).length > 0) {
    await appendChannelSecrets(options.cwd, options.channel, tokens)
  }
  emit({ step: 'secrets', phase: 'done' })
}

// `channel add` mirrors `runInit`'s allow defaults: workspace-scoped adapters
// (discord/slack/telegram) default to `*` because the bot only sees what the
// operator invited it into, while KakaoTalk uses a personal account and
// defaults to DMs only.
function defaultAllowAll(channel: ChannelKind): boolean {
  return channel !== 'kakaotalk'
}

function channelSecretsFromOptions(options: AddChannelOptions): ChannelSecrets {
  switch (options.channel) {
    case 'discord-bot':
      return { DISCORD_BOT_TOKEN: options.discordBotToken }
    case 'slack-bot':
      return { SLACK_BOT_TOKEN: options.slackBotToken, SLACK_APP_TOKEN: options.slackAppToken }
    case 'telegram-bot':
      return { TELEGRAM_BOT_TOKEN: options.telegramBotToken }
    case 'kakaotalk':
      // KakaoTalk credentials live in `workspace/.agent-messenger/`, written
      // by the auth runner above. Nothing to record in secrets.json.
      return {}
  }
}

type ChannelSecrets = Record<string, string>

// Returns the set of channel keys already present in typeclaw.json. Used by
// the CLI's picker to hide already-configured adapters and to reject explicit
// re-adds with a clear error rather than silently merging.
export async function readConfiguredChannels(cwd: string): Promise<Set<ChannelKind>> {
  const path = join(cwd, CONFIG_FILE)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
    throw error
  }
  const parsed = JSON.parse(raw) as { channels?: Record<string, unknown> }
  const channels = parsed.channels ?? {}
  const present = new Set<ChannelKind>()
  for (const kind of CHANNEL_KINDS) {
    if (kind in channels) present.add(kind)
  }
  return present
}

async function mergeChannelIntoConfig(cwd: string, channel: ChannelKind, allowAll: boolean): Promise<void> {
  const path = join(cwd, CONFIG_FILE)
  let parsed: Record<string, unknown>
  try {
    const raw = await readFile(path, 'utf8')
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `${CONFIG_FILE} not found at ${cwd}. Run \`typeclaw init\` before adding channels, or run this command from inside an agent folder.`,
      )
    }
    throw error
  }

  const existingChannels =
    typeof parsed.channels === 'object' && parsed.channels !== null && !Array.isArray(parsed.channels)
      ? (parsed.channels as Record<string, unknown>)
      : {}

  if (channel in existingChannels) {
    // Defense in depth — the CLI already filters configured channels out of
    // the picker and rejects them as the positional arg. Hitting this branch
    // means a programmatic caller passed a duplicate; better to fail loudly
    // than silently overwrite the user's existing allow list.
    throw new Error(`Channel "${channel}" is already configured in ${CONFIG_FILE}.`)
  }

  parsed.channels = {
    ...existingChannels,
    [channel]: { allow: buildAllow(channel, allowAll) },
  }

  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`)
}

function buildAllow(channel: ChannelKind, allowAll: boolean): string[] {
  if (channel === 'kakaotalk') return allowAll ? ['kakao:*'] : ['kakao:dm/*']
  return allowAll ? ['*'] : []
}

// Writes tokens into `secrets.json#channels.<adapter>`. Refuses to overwrite
// existing keys: if the user already has `SLACK_BOT_TOKEN` recorded (from a
// prior `channel add` whose follow-up steps failed, or a hand-edit), we
// surface that as a hard error rather than silently displace it. Same trap
// the old .env-append path guarded against, applied to the new destination.
async function appendChannelSecrets(cwd: string, channel: ChannelKind, tokens: ChannelSecrets): Promise<void> {
  if (Object.keys(tokens).length === 0) return

  if (!existsSync(join(cwd, CONFIG_FILE))) {
    throw new Error(
      `${CONFIG_FILE} not found at ${cwd}. Run \`typeclaw init\` before adding channels, or run this command from inside an agent folder.`,
    )
  }

  const backend = new SecretsBackend(join(cwd, 'secrets.json'))
  const channels = backend.readChannelsSync()
  const slot = isStringRecord(channels[channel]) ? { ...(channels[channel] as Record<string, string>) } : {}

  for (const key of Object.keys(tokens)) {
    if (slot[key] !== undefined) {
      throw new Error(
        `${key} is already set in secrets.json under "${channel}". Remove it before re-adding the channel, or edit the value by hand.`,
      )
    }
  }
  for (const [k, v] of Object.entries(tokens)) slot[k] = v
  channels[channel] = slot
  backend.writeChannelsSync(channels)
}
