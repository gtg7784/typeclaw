import { TYPECLAW_VERSION } from '../../generated/version'

export const INSTALL_COMMAND = 'bun add -g typeclaw'

export const VERSION = `v${TYPECLAW_VERSION}`

export interface DocLink {
  href: string
  title: string
  blurb: string
}

export const DOC_LINKS: DocLink[] = [
  { href: '/docs/guides/getting-started', title: 'Getting started', blurb: 'install through first reply' },
  { href: '/docs/guides/first-channel', title: 'Add a channel', blurb: 'wire Slack, Discord, Telegram, GitHub' },
  { href: '/docs/guides/teach-the-agent', title: 'Teach the agent', blurb: 'the self-improving memory loop' },
  { href: '/docs/guides/write-a-plugin', title: 'Write a plugin', blurb: 'tools, skills, and channels in TypeScript' },
  {
    href: '/docs/concepts/architecture',
    title: 'Architecture',
    blurb: 'three stages, the host daemon, the trust boundary',
  },
  { href: '/docs/reference/typeclaw-json', title: 'Reference', blurb: 'every field, every flag, every grammar' },
]

export type CompetitorScore = true | false | 'partial'

export interface Competitor {
  name: string
  strength: string
  tradeoff: string
  lang: string
  dockerFirst: CompetitorScore
  selfImproving: CompetitorScore
  multiChannel: CompetitorScore
  fullFeaturedPlugins: CompetitorScore
  gitNative: CompetitorScore
  permissionSystem: CompetitorScore
  highlight?: boolean
}

export const COMPETITORS: Competitor[] = [
  {
    name: 'OpenClaw',
    strength: 'Biggest ecosystem',
    tradeoff: 'a platform to learn, not a codebase to read',
    lang: 'TypeScript',
    dockerFirst: true,
    selfImproving: 'partial',
    multiChannel: true,
    fullFeaturedPlugins: true,
    gitNative: false,
    permissionSystem: true,
  },
  {
    name: 'NanoClaw',
    strength: 'Minimal',
    tradeoff: 'no real plugin system',
    lang: 'TypeScript',
    dockerFirst: false,
    selfImproving: false,
    multiChannel: false,
    fullFeaturedPlugins: false,
    gitNative: false,
    permissionSystem: true,
  },
  {
    name: 'PicoClaw',
    strength: 'Ultralight',
    tradeoff: 'plugins live outside the runtime',
    lang: 'Go',
    dockerFirst: false,
    selfImproving: false,
    multiChannel: 'partial',
    fullFeaturedPlugins: 'partial',
    gitNative: false,
    permissionSystem: false,
  },
  {
    name: 'ZeroClaw',
    strength: 'Single binary',
    tradeoff: 'plugins live outside the runtime',
    lang: 'Rust',
    dockerFirst: false,
    selfImproving: false,
    multiChannel: 'partial',
    fullFeaturedPlugins: 'partial',
    gitNative: false,
    permissionSystem: true,
  },
  {
    name: 'Hermes Agent',
    strength: 'Mature, self-improving',
    tradeoff: 'Python — a boundary if your stack is TS',
    lang: 'Python',
    dockerFirst: 'partial',
    selfImproving: true,
    multiChannel: true,
    fullFeaturedPlugins: true,
    gitNative: 'partial',
    permissionSystem: false,
  },
  {
    name: 'TypeClaw',
    strength: 'One TS codebase, plugins as imports',
    tradeoff: 'younger, smaller ecosystem',
    lang: 'TypeScript',
    dockerFirst: true,
    selfImproving: true,
    multiChannel: true,
    fullFeaturedPlugins: true,
    gitNative: true,
    permissionSystem: true,
    highlight: true,
  },
]

export interface MemoryStage {
  label: string
  blurb: string
}

export const MEMORY_LOOP: MemoryStage[] = [
  { label: 'Session log', blurb: 'every reply and tool call is appended to a daily stream' },
  { label: 'Dreaming subagent', blurb: 'distills the day into fragments on its own schedule' },
  { label: 'Sharded memory', blurb: 'fragments land in memory/topics/, sharded by subject' },
  { label: 'Reusable skill', blurb: 'recurring procedures get written into a markdown skill' },
]
