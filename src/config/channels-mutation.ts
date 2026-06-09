import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { commitSystemFileSync } from '@/git/system-commit'
import { SecretsBackend } from '@/secrets'

const CONFIG_FILE = 'typeclaw.json'
const SECRETS_FILE = 'secrets.json'

export const CHANNEL_KINDS = ['slack-bot', 'discord-bot', 'telegram-bot', 'line', 'kakaotalk', 'github'] as const

export type ChannelKind = (typeof CHANNEL_KINDS)[number]

export type ChannelListEntry = {
  kind: ChannelKind
  configured: boolean
  hasSecrets: boolean
  enabled: boolean
  detail?: string
}

export type GithubConfigCleanup = {
  tunnelsRemoved: number
  matchRulesRemoved: string[]
  matchRulesKept: string[]
}

export type RemoveChannelResult =
  | {
      ok: true
      configRemoved: boolean
      secretsRemoved: boolean
      githubCleanup?: GithubConfigCleanup
      hadRemoteWebhooks: boolean
    }
  | { ok: false; reason: string }

export function isChannelKind(value: string): value is ChannelKind {
  return (CHANNEL_KINDS as ReadonlyArray<string>).includes(value)
}

export function listChannels(cwd: string): ChannelListEntry[] {
  const config = readConfigRecordOrEmpty(cwd)
  const configuredChannels = isObjectRecord(config.channels) ? config.channels : {}
  const secrets = readChannelSecretsOrEmpty(cwd)

  return CHANNEL_KINDS.map((kind) => {
    const channelConfig = configuredChannels[kind]
    const configured = kind in configuredChannels
    const hasSecrets = kind in secrets
    return {
      kind,
      configured,
      hasSecrets,
      enabled: readEnabled(channelConfig),
      ...buildDetail(kind, channelConfig, secrets[kind]),
    }
  }).filter((entry) => entry.configured || entry.hasSecrets)
}

export function removeChannel(cwd: string, kind: ChannelKind): RemoveChannelResult {
  const config = readConfigRecord(cwd)
  if (!config.ok) return config

  const channels = isObjectRecord(config.value.channels) ? { ...config.value.channels } : {}
  const secrets = readChannelSecretsOrEmpty(cwd)

  const inConfig = kind in channels
  const inSecrets = kind in secrets
  if (!inConfig && !inSecrets) {
    return { ok: false, reason: `Channel "${kind}" is not configured in ${CONFIG_FILE} or ${SECRETS_FILE}.` }
  }

  const githubRepos = kind === 'github' ? readGithubRepos(channels.github) : []
  const hadRemoteWebhooks = githubRepos.length > 0

  delete channels[kind]
  config.value.channels = channels

  const githubCleanup = kind === 'github' ? cleanGithubConfig(config.value, githubRepos) : undefined

  const write = writeConfig(cwd, config.value, `channel: remove ${kind}`)
  if (!write.ok) return write

  const secretsRemoved = new SecretsBackend(join(cwd, SECRETS_FILE)).removeChannelSync(kind)

  return {
    ok: true,
    configRemoved: inConfig,
    secretsRemoved,
    ...(githubCleanup !== undefined ? { githubCleanup } : {}),
    hadRemoteWebhooks,
  }
}

// GitHub `add` writes three config artifacts beyond `channels.github`: a
// `tunnels[]` entry marked `for: { kind: 'channel', name: 'github' }`,
// `roles.member.match[]` rules `github:<owner>/<repo>`, and the
// `docker.file.cloudflared` enablement flag. Removal strips the first two
// (both channel-owned) but intentionally leaves `docker.file.cloudflared`: it
// is a shared enablement flag a remaining tunnel may still need. Match-rule
// stripping is scoped to the configured repos so hand-authored `github:`
// identities survive.
function cleanGithubConfig(config: Record<string, unknown>, repos: string[]): GithubConfigCleanup {
  const tunnelsRemoved = removeGithubTunnels(config)
  const { removed, kept } = removeGithubMatchRules(config, repos)
  return { tunnelsRemoved, matchRulesRemoved: removed, matchRulesKept: kept }
}

function removeGithubTunnels(config: Record<string, unknown>): number {
  if (!Array.isArray(config.tunnels)) return 0
  const before = config.tunnels.length
  config.tunnels = config.tunnels.filter((entry) => !isGithubChannelTunnel(entry))
  return before - (config.tunnels as unknown[]).length
}

function isGithubChannelTunnel(entry: unknown): boolean {
  if (!isObjectRecord(entry)) return false
  const target = entry.for
  if (!isObjectRecord(target)) return false
  return target.kind === 'channel' && target.name === 'github'
}

function readGithubRepos(githubConfig: unknown): string[] {
  if (!isObjectRecord(githubConfig) || !Array.isArray(githubConfig.repos)) return []
  return githubConfig.repos.filter((repo): repo is string => typeof repo === 'string')
}

function removeGithubMatchRules(
  config: Record<string, unknown>,
  repos: string[],
): { removed: string[]; kept: string[] } {
  const roles = isObjectRecord(config.roles) ? { ...config.roles } : undefined
  const member = roles !== undefined && isObjectRecord(roles.member) ? { ...roles.member } : undefined
  if (roles === undefined || member === undefined || !Array.isArray(member.match)) {
    return { removed: [], kept: [] }
  }

  const toRemove = new Set(repos.map((repo) => `github:${repo}`))
  const removed: string[] = []
  const kept: string[] = []
  const next = member.match
    .filter((rule): rule is string => typeof rule === 'string')
    .filter((rule) => {
      if (toRemove.has(rule)) {
        removed.push(rule)
        return false
      }
      if (rule.startsWith('github:')) kept.push(rule)
      return true
    })

  if (removed.length === 0) return { removed: [], kept }

  member.match = next
  roles.member = member
  config.roles = roles
  return { removed, kept }
}

function buildDetail(kind: ChannelKind, channelConfig: unknown, secretsBlock: unknown): { detail?: string } {
  if (kind === 'github') {
    const repos = isObjectRecord(channelConfig) && Array.isArray(channelConfig.repos) ? channelConfig.repos.length : 0
    return { detail: `${repos} repo${repos === 1 ? '' : 's'}` }
  }
  if (kind === 'line' || kind === 'kakaotalk') {
    if (!isObjectRecord(secretsBlock)) return {}
    const accounts = isObjectRecord(secretsBlock.accounts) ? Object.keys(secretsBlock.accounts).length : 0
    const current = typeof secretsBlock.currentAccount === 'string' ? secretsBlock.currentAccount : undefined
    const accountLabel = `${accounts} account${accounts === 1 ? '' : 's'}`
    return { detail: current !== undefined ? `${accountLabel} (active: ${current})` : accountLabel }
  }
  return {}
}

function readEnabled(channelConfig: unknown): boolean {
  if (isObjectRecord(channelConfig) && typeof channelConfig.enabled === 'boolean') return channelConfig.enabled
  return true
}

function readConfigRecord(cwd: string): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  try {
    const raw = readFileSync(join(cwd, CONFIG_FILE), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!isObjectRecord(parsed)) return { ok: false, reason: `${CONFIG_FILE} must contain a JSON object.` }
    return { ok: true, value: parsed }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, reason: `${CONFIG_FILE} not found at ${cwd}. Run \`typeclaw init\` first.` }
    }
    return { ok: false, reason: `Failed to read ${CONFIG_FILE}: ${(error as Error).message}` }
  }
}

function readConfigRecordOrEmpty(cwd: string): Record<string, unknown> {
  const result = readConfigRecord(cwd)
  return result.ok ? result.value : {}
}

function readChannelSecretsOrEmpty(cwd: string): Record<string, unknown> {
  try {
    const channels = new SecretsBackend(join(cwd, SECRETS_FILE)).tryReadChannelsSync()
    return channels === null ? {} : (channels as Record<string, unknown>)
  } catch {
    return {}
  }
}

function writeConfig(
  cwd: string,
  record: Record<string, unknown>,
  commitMessage: string,
): { ok: true } | { ok: false; reason: string } {
  try {
    writeFileSync(join(cwd, CONFIG_FILE), `${JSON.stringify(record, null, 2)}\n`)
  } catch (error) {
    return { ok: false, reason: `Failed to write ${CONFIG_FILE}: ${(error as Error).message}` }
  }
  commitSystemFileSync(cwd, CONFIG_FILE, commitMessage)
  return { ok: true }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
