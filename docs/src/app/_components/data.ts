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
  knowsWhenToTalk: CompetitorScore
  perAgentIsolation: CompetitorScore
  pluginsAsImports: CompetitorScore
  permissionsGuards: CompetitorScore
  perAgentGitRepo: CompetitorScore
  selfManaging: CompetitorScore
  highlight?: boolean
}

export const COMPETITORS: Competitor[] = [
  {
    name: 'OpenClaw',
    strength: 'Biggest ecosystem',
    tradeoff: 'a platform to learn, not a codebase to read',
    lang: 'TypeScript',
    knowsWhenToTalk: true,
    perAgentIsolation: true,
    pluginsAsImports: true,
    permissionsGuards: true,
    perAgentGitRepo: 'partial',
    selfManaging: 'partial',
  },
  {
    name: 'Hermes Agent',
    strength: 'Mature, self-improving',
    tradeoff: 'Python — a boundary if your stack is TS',
    lang: 'Python',
    knowsWhenToTalk: 'partial',
    perAgentIsolation: 'partial',
    pluginsAsImports: false,
    permissionsGuards: true,
    perAgentGitRepo: true,
    selfManaging: true,
  },
  {
    name: 'TypeClaw',
    strength: 'One TS codebase, plugins as imports',
    tradeoff: 'younger, smaller ecosystem',
    lang: 'TypeScript',
    knowsWhenToTalk: true,
    perAgentIsolation: true,
    pluginsAsImports: true,
    permissionsGuards: true,
    perAgentGitRepo: true,
    selfManaging: true,
    highlight: true,
  },
]

type ScoreKey = {
  [K in keyof Competitor]-?: Competitor[K] extends CompetitorScore ? K : never
}[keyof Competitor]

export interface ComparisonFeature {
  key: ScoreKey
  label: string
}

export const COMPARISON_FEATURES: ComparisonFeature[] = [
  { key: 'knowsWhenToTalk', label: 'Knows when not to talk' },
  { key: 'perAgentIsolation', label: 'Per-agent isolation' },
  { key: 'pluginsAsImports', label: 'Plugins as imports' },
  { key: 'permissionsGuards', label: 'Permissions & guards' },
  { key: 'perAgentGitRepo', label: 'Per-agent git repo' },
  { key: 'selfManaging', label: 'Self-managing' },
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
