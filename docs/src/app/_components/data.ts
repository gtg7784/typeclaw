export const INSTALL_COMMAND = 'bun add -g typeclaw'

export interface Feature {
  title: string
  detail: string
}

export const FEATURES: Feature[] = [
  { title: 'Sandboxed by default', detail: 'every agent runs in its own Docker container' },
  { title: 'TypeScript end to end', detail: 'core, plugins, channels, CLI, TUI' },
  { title: 'Plugins as TS modules', detail: 'plain .ts files; no IPC, no FFI' },
  { title: 'Multi-channel', detail: 'Slack, Discord, Telegram, KakaoTalk, GitHub — plus a websocket TUI' },
  { title: 'Cron', detail: 'scheduled prompts and shell commands, with coalescing' },
  { title: 'Self-improving memory', detail: 'observes its own work and writes its own skills' },
  { title: 'Hot reload', detail: 'most config reloads live; boot-only fields ask for a restart' },
  { title: 'Auto port-forward', detail: 'dev servers in the container appear on localhost' },
  { title: 'Public tunnels', detail: 'Cloudflare Quick or your own URL — built in' },
  { title: 'Skills on demand', detail: 'markdown procedures with zero token cost until used' },
  { title: 'Group-chat aware', detail: 'knows who is in the room and when to reply' },
  { title: 'Roles and permissions', detail: 'platform-aware match rules gate every action' },
]

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
    strength: 'Feature-rich',
    tradeoff: 'Heavy',
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
    strength: 'Simple',
    tradeoff: 'No plugin system',
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
    strength: 'Fast',
    tradeoff: 'Plugins live outside the runtime',
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
    strength: 'Light',
    tradeoff: 'Plugins live outside the runtime',
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
    strength: 'Awesome',
    tradeoff: 'Python',
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
    strength: 'TypeScript end to end',
    tradeoff: 'the answer',
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
