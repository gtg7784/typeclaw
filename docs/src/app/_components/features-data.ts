import {
  Box,
  Clock,
  Globe,
  Inbox,
  LayoutGrid,
  type LucideIcon,
  MessagesSquare,
  Network,
  Plug,
  RefreshCw,
  Shield,
  Sprout,
  Terminal,
  Users,
} from 'lucide-react'

export interface FeatureBullet {
  title: string
  detail: string
}

export interface FeatureCategory {
  id: string
  icon: LucideIcon
  title: string
  tagline: string
  summary: string
  bullets: FeatureBullet[]
  featured?: boolean
}

export const FEATURE_CATEGORIES: FeatureCategory[] = [
  {
    id: 'self-improving',
    icon: Sprout,
    title: 'Self-improving',
    tagline: 'a learning loop, not a black box',
    summary: 'It distills each day of work into long-term memory and reusable skills you can read in git.',
    featured: true,
    bullets: [
      { title: 'Memory', detail: 'logs its own work to a daily stream as it goes.' },
      {
        title: 'Dreaming',
        detail:
          "a subagent distills each day's work into long-term memory, committed to git as plain files you can read, diff, and revert.",
      },
      {
        title: 'Muscle memory',
        detail: 'recurring procedures become reusable skills it writes for itself and loads on later runs.',
      },
      {
        title: 'Optional embedding recall',
        detail:
          'hybrid keyword-and-embedding search over the same markdown memory, off by default; the plain files remain the durable source of truth.',
      },
    ],
  },
  {
    id: 'group-chat',
    icon: MessagesSquare,
    title: 'Group chat',
    tagline: 'knows when not to talk',
    summary: 'It reads the room, tells humans from bots, and stays quiet when a message was not meant for it.',
    featured: true,
    bullets: [
      {
        title: 'Room awareness',
        detail:
          "knows who's present and tells humans from bots, so it stays quiet when people are talking to each other rather than chiming in on messages it wasn't part of.",
      },
      {
        title: 'Sticky engagement',
        detail:
          'holds an ongoing thread after replying without needing to be re-mentioned, then steps back when the conversation moves on. Multilingual continuation detection, peer-bot loop guards, and flood filters keep it from spiraling.',
      },
    ],
  },
  {
    id: 'scheduling',
    icon: Clock,
    title: 'Scheduling',
    tagline: 'on its own clock',
    summary: 'Recurring prompts or shell commands and future reminders, fired at a timezone-safe instant.',
    featured: true,
    bullets: [
      {
        title: 'Recurring tasks',
        detail: 'scheduled prompts or shell commands, with per-job coalescing and timezone support.',
      },
      {
        title: 'Future reminders',
        detail: 'schedule a prompt or command to fire later at a timezone-safe instant.',
      },
    ],
  },
  {
    id: 'web-research',
    icon: Globe,
    title: 'Web & research',
    tagline: 'reads the web like a person',
    summary: 'It searches the live web, reads pages as articles, and drives a real browser when a site needs one.',
    bullets: [
      {
        title: 'Live web search & fetch',
        detail: 'pull a page as a readable article, a JSON query, a selected slice, a grep, or raw.',
      },
      {
        title: 'Browser-like fetching',
        detail: "replays a real browser fingerprint so requests aren't rejected by sites that block generic clients.",
      },
      {
        title: 'Interactive browser sessions',
        detail: 'drives a browser on live pages, with a dashboard you can step into for logins, 2FA, or CAPTCHA.',
      },
    ],
  },
  {
    id: 'channels',
    icon: Inbox,
    title: 'Channels',
    tagline: 'one agent, many inboxes',
    summary: 'Slack, Discord, Telegram, LINE, KakaoTalk, GitHub, and a websocket TUI, driven by the same agent.',
    bullets: [
      {
        title: 'Supported channels',
        detail: 'Slack, Discord, Telegram, LINE, KakaoTalk, GitHub, and a websocket TUI, driven by the same agent.',
      },
      {
        title: 'Pull-request review',
        detail:
          "treats a GitHub PR as a conversation, reviewing as a participant, with guards against claiming a verdict it didn't actually post and against leaving a PR stranded.",
      },
    ],
  },
  {
    id: 'security',
    icon: Shield,
    title: 'Security',
    tagline: 'defense-in-depth for risky actions',
    summary: 'Layered guards, role gates, per-channel match rules, and encryption at rest for sensitive credentials.',
    featured: true,
    bullets: [
      {
        title: 'Layered guards',
        detail:
          'stop secret exfiltration, SSRF, prompt injection, rogue git pushes, and silent privilege escalation before they fire.',
      },
      {
        title: 'Roles',
        detail: 'owner, trusted, member, and guest gate privileged actions.',
      },
      {
        title: 'Permissions',
        detail:
          "per-channel match rules decide who can ask for what; an untrusted channel user can't trigger privileged behavior.",
      },
      {
        title: 'Encryption at rest',
        detail:
          'sensitive channel passwords are sealed with authenticated encryption; the key is host-held and is not passed into the container during normal operation.',
      },
    ],
  },
  {
    id: 'isolation-sandbox',
    icon: Box,
    title: 'Isolation & Sandbox',
    tagline: "runs clean, stays out of each other's way",
    summary: 'Each agent lives in its own folder and container, so nothing installs globally and agents never collide.',
    featured: true,
    bullets: [
      {
        title: 'No machine clutter',
        detail:
          'an agent lives in its own folder and runs in its own container. Nothing installs globally on your system; stop it and the running pieces shut down, leaving a folder you can keep, copy, or delete.',
      },
      {
        title: 'No cross-agent interference',
        detail:
          'run as many as you like; each gets its own container, its own files, memory, and even its own browser. One agent can be reading a page while another drives a different one — neither disturbs the other.',
      },
      {
        title: 'Self-contained folder',
        detail:
          "settings, memory, and connections live together in the agent's folder, kept as a version history you can review, undo, or back up.",
      },
    ],
  },
  {
    id: 'subagents',
    icon: Users,
    title: 'Subagents',
    tagline: 'delegation in a fresh context',
    summary:
      'It hands off research, planning, review, and execution to focused child sessions, sync or in the background.',
    featured: true,
    bullets: [
      {
        title: 'A bench of specialists',
        detail:
          'it hands off research, planning, code review, and hands-on execution to focused child sessions, each with its own prompt, tools, and model.',
      },
      {
        title: 'Sync or background',
        detail:
          'spawn and block for a result, or spawn in the background and collect completions later; coalescing prevents duplicate concurrent runs and depth limits keep delegation chains bounded.',
      },
    ],
  },
  {
    id: 'extensibility',
    icon: Plug,
    title: 'Extensibility',
    tagline: 'teach it new tricks in TypeScript',
    summary: 'Plugins are plain TypeScript imports; add MCP servers, lazy skills, and hot-reloadable typed config.',
    featured: true,
    bullets: [
      {
        title: 'Plugins are just imports',
        detail:
          'a plugin is a plain TypeScript file that imports the runtime and adds tools, skills, channels, and commands. No IPC, no FFI, no plugin DSL. Distributed as packages and resolved like any dependency.',
      },
      {
        title: 'MCP support',
        detail: "connect external MCP servers over stdio or HTTP; their tools become the agent's tools.",
      },
      {
        title: 'Skills on demand',
        detail:
          'markdown procedures load lazily when selected, so they avoid prompt-token cost until used. Skills layer from bundled, your own, and what the agent learns.',
      },
      {
        title: 'Typed config with hot reload',
        detail: 'most config changes take effect live; boot-only fields are flagged restart-required.',
      },
    ],
  },
  {
    id: 'connectivity',
    icon: Network,
    title: 'Connectivity',
    tagline: 'reachable wherever you need it',
    summary: 'Container services appear on your localhost; a zero-signup public URL, or bring your own.',
    bullets: [
      {
        title: 'Auto port-forward',
        detail: 'services inside the container appear on your `localhost`, including loopback-only ones.',
      },
      {
        title: 'Public tunnels',
        detail:
          'a zero-signup public URL out of the box, or bring your own; webhooks self-register at the resulting URL.',
      },
      {
        title: 'Private network access',
        detail: 'forwarded ports can publish to a private network when configured.',
      },
    ],
  },
  {
    id: 'self-managing',
    icon: RefreshCw,
    title: 'Self-managing',
    tagline: 'operational autonomy, on a budget',
    summary: 'It backs up its own state, can restart its container, and keeps working through a budgeted task list.',
    bullets: [
      {
        title: 'Self-backup',
        detail: 'commits and pushes its own state during idle windows, with a generated commit message.',
      },
      {
        title: 'Self-restart',
        detail: 'can rebuild and restart its own container when it needs to, through the host daemon.',
      },
      {
        title: 'Self-continuation',
        detail:
          'keeps working through an unfinished task list when you step away, bounded by a turn, token, and wall-clock budget.',
      },
    ],
  },
  {
    id: 'operator-cli',
    icon: Terminal,
    title: 'Operator CLI',
    tagline: 'see what it\u2019s doing and what it costs',
    summary: 'doctor, usage, inspect, and logs show what the agent is doing, what it spends, and how it is wired.',
    bullets: [
      {
        title: 'doctor',
        detail: 'diagnoses host, agent folder, config, and channels, with auto-fix for managed files.',
      },
      {
        title: 'usage',
        detail: 'reports token and dollar spend by day, model, session, or origin.',
      },
      {
        title: 'inspect',
        detail: 'replays a session transcript and tails live activity.',
      },
      {
        title: 'logs',
        detail: 'streams container logs with local-time prefixes.',
      },
    ],
  },
  {
    id: 'compose',
    icon: LayoutGrid,
    title: 'Compose',
    tagline: 'manage a fleet from the CLI',
    summary:
      'Discover agent folders and start, stop, check, and diagnose them across your fleet from the command line.',
    featured: true,
    bullets: [
      {
        title: 'Fleet operations',
        detail:
          'discover agent folders and start, stop, restart, check status, tail logs, report usage, and run diagnostics across them from the command line.',
      },
    ],
  },
]
