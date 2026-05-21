'use client'

import { useTheme } from 'next-themes'
import Link from 'next/link'
import { useEffect, useState } from 'react'

function PawIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <title>TypeClaw paw</title>
      <ellipse cx="6" cy="9" rx="2.2" ry="3" />
      <ellipse cx="18" cy="9" rx="2.2" ry="3" />
      <ellipse cx="10" cy="5" rx="2" ry="2.8" />
      <ellipse cx="14" cy="5" rx="2" ry="2.8" />
      <path d="M12 11.5c-3.5 0-6 2.4-6 5.2 0 2.3 1.8 3.8 4 3.8 1.2 0 1.4-.6 2-.6s.8.6 2 .6c2.2 0 4-1.5 4-3.8 0-2.8-2.5-5.2-6-5.2z" />
    </svg>
  )
}

function ContainerIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 7l9-4 9 4-9 4-9-4z" />
      <path d="M3 7v10l9 4 9-4V7" />
      <path d="M12 11v10" />
    </svg>
  )
}

function PlugIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M9 2v6" />
      <path d="M15 2v6" />
      <path d="M6 8h12v4a6 6 0 01-12 0V8z" />
      <path d="M12 18v4" />
    </svg>
  )
}

function ChatIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" />
    </svg>
  )
}

function BrainIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 4a4 4 0 00-4 4 3 3 0 00-1.5 5.6A3.5 3.5 0 008 20a3 3 0 004-2.7" />
      <path d="M12 4a4 4 0 014 4 3 3 0 011.5 5.6A3.5 3.5 0 0116 20a3 3 0 01-4-2.7" />
      <path d="M12 4v16" />
    </svg>
  )
}

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  )
}

function ZapIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  )
}

function GlobeIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a13 13 0 010 18 13 13 0 010-18z" />
    </svg>
  )
}

function ShieldIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M9.5 12.5L11 14l3.5-3.5" />
    </svg>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        })
      }}
      className="flex items-center justify-center rounded-md p-1.5 text-zinc-400 transition-colors hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
      aria-label={copied ? 'Copied' : 'Copy to clipboard'}
    >
      {copied ? (
        <svg
          className="size-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg
          className="size-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
        </svg>
      )}
    </button>
  )
}

function ThemeToggle() {
  const [mounted, setMounted] = useState(false)
  const { setTheme, resolvedTheme } = useTheme()

  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) {
    return <div className="size-9" />
  }

  return (
    <button
      type="button"
      onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
      className="flex size-9 items-center justify-center rounded-lg text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
      aria-label="Toggle theme"
    >
      {resolvedTheme === 'dark' ? (
        <svg
          className="size-[18px]"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="5" />
          <line x1="12" y1="1" x2="12" y2="3" />
          <line x1="12" y1="21" x2="12" y2="23" />
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
          <line x1="1" y1="12" x2="3" y2="12" />
          <line x1="21" y1="12" x2="23" y2="12" />
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
          <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
        </svg>
      ) : (
        <svg
          className="size-[18px]"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
        </svg>
      )}
    </button>
  )
}

function TerminalBlock({ title, copyText, children }: { title?: string; copyText: string; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center justify-between border-b border-zinc-200 bg-zinc-100 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex gap-2">
          <span className="size-3 rounded-full bg-zinc-300 dark:bg-zinc-700" />
          <span className="size-3 rounded-full bg-zinc-300 dark:bg-zinc-700" />
          <span className="size-3 rounded-full bg-zinc-300 dark:bg-zinc-700" />
        </div>
        <span className="font-mono text-xs text-zinc-400 dark:text-zinc-500">{title ?? 'terminal'}</span>
        <CopyButton text={copyText} />
      </div>
      <pre className="overflow-x-auto p-5 font-mono text-sm leading-relaxed">
        <code>{children}</code>
      </pre>
    </div>
  )
}

interface TerminalLine {
  prompt?: string
  cmd?: string
  output?: string
}

interface TerminalDemo {
  tab: string
  commands: TerminalLine[]
}

const TERMINAL_DEMOS: TerminalDemo[] = [
  {
    tab: 'init',
    commands: [
      { prompt: '$ ', cmd: 'mkdir my-agent && cd my-agent' },
      { prompt: '$ ', cmd: 'typeclaw init' },
      { output: '✓ wrote typeclaw.json, .env, Dockerfile, package.json' },
      { output: '✓ created workspace/, sessions/, memory/' },
      { prompt: '$ ', cmd: 'typeclaw start' },
      { output: '✓ image built (12s) — container my-agent up on :8973' },
    ],
  },
  {
    tab: 'channels',
    commands: [
      { prompt: '$ ', cmd: 'typeclaw channel add slack-bot' },
      { output: '✓ slack-bot wired — answering in #standup' },
      { prompt: '$ ', cmd: 'typeclaw channel add github' },
      { output: '✓ webhook registered via cloudflare-quick tunnel' },
      { prompt: '$ ', cmd: 'typeclaw tui' },
      { output: '⌁ connected to ws://localhost:8973' },
    ],
  },
  {
    tab: 'cron',
    commands: [
      { prompt: '$ ', cmd: 'cat cron.json' },
      { output: '{ "jobs": [{ "name": "morning-status",' },
      { output: '             "schedule": "0 9 * * *",' },
      { output: '             "prompt": "summarize yesterday\'s PRs" }] }' },
      { prompt: '$ ', cmd: 'typeclaw reload' },
      { output: '✓ cron updated — next run 09:00' },
    ],
  },
  {
    tab: 'memory',
    commands: [
      { prompt: '$ ', cmd: 'git log memory/ --oneline' },
      { output: "a3f2c1d dream: 4 fragments + new skill 'pr-review' 🔮" },
      { output: '7b1e0d2 dream: 2 fragments → MEMORY.md updated' },
      { output: "4d9a8c1 dream: new skill 'incident-summary' 🔮" },
      { prompt: '$ ', cmd: 'ls memory/skills/' },
      { output: 'incident-summary/  pr-review/' },
    ],
  },
]

const FEATURES = [
  {
    icon: <ContainerIcon className="size-5" />,
    title: 'Sandboxed by default',
    description:
      'Every agent runs in its own Docker container, with its own .env and bind-mounted host folders. The host CLI is a launcher; nothing the agent does escapes the container.',
  },
  {
    icon: <PlugIcon className="size-5" />,
    title: 'Plugins as TS modules',
    description:
      'Contribute tools, skills, subagents, channel adapters, and typed config from one TypeScript file. No IPC, no FFI, no subprocess. Just imports.',
  },
  {
    icon: <ChatIcon className="size-5" />,
    title: 'Multi-channel',
    description:
      'Slack, Discord, GitHub, Telegram, KakaoTalk, and a websocket TUI — built-in. One agent, many inboxes, all routed through one in-process message stream.',
  },
  {
    icon: <BrainIcon className="size-5" />,
    title: 'Self-improving memory',
    description:
      'Observes work after every idle turn, dreams nightly to consolidate fragments into MEMORY.md, and writes new skills for procedures it recognizes itself running.',
  },
  {
    icon: <ClockIcon className="size-5" />,
    title: 'Cron with coalescing',
    description:
      "Schedule prompts or shell commands. Per-job coalescing means a slow daily job can't pile up into 24 backlogged runs overnight.",
  },
  {
    icon: <ZapIcon className="size-5" />,
    title: 'Hot reload',
    description:
      'Edit typeclaw.json, run typeclaw reload — no restart for most fields. Boot-only fields tell you when they need a restart instead of silently failing.',
  },
  {
    icon: <GlobeIcon className="size-5" />,
    title: 'Auto port-forward',
    description:
      'Dev servers inside the container appear on localhost — even loopback-only ones bound to 127.0.0.1. The host-side broker pumps bytes through the container netns.',
  },
  {
    icon: <ShieldIcon className="size-5" />,
    title: 'Roles and permissions',
    description:
      'Role-based access control with platform-aware match rules. The agent answers only the conversations you allow, gates secret-exfil tools by severity tier.',
  },
]

const STAGES = [
  {
    name: 'Dev stage',
    description: 'TypeClaw source tree — what we ship to npm.',
    detail: 'bun test, typecheck, lint, format. No agent runs here; just code that the host stage will execute.',
  },
  {
    name: 'Host stage',
    description: 'Your machine, where typeclaw init / start / tui live.',
    detail:
      "Native filesystem access. Owns the agent folder and the per-host ~/.typeclaw/ daemon state. Has no model access — it's a launcher.",
  },
  {
    name: 'Container stage',
    description: 'Inside Docker, where the agent loop runs.',
    detail:
      'No Docker access from here. Talks to the host stage over a small RPC daemon for restart and port-forward. The model only thinks here.',
  },
]

const COMPARISONS = [
  {
    runtime: 'OpenClaw',
    strength: 'Feature-rich',
    weakness: 'Heavy',
  },
  {
    runtime: 'NanoClaw',
    strength: 'Simple',
    weakness: 'No plugin system',
  },
  {
    runtime: 'PicoClaw',
    strength: 'Fast',
    weakness: 'Go — plugins live outside the runtime',
  },
  {
    runtime: 'ZeroClaw',
    strength: 'Light',
    weakness: 'Rust — same problem, different ecosystem',
  },
  {
    runtime: 'Hermes Agent',
    strength: 'Awesome',
    weakness: 'Python',
  },
]

function CyclingTerminal() {
  const [active, setActive] = useState(0)
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    if (paused) return
    const timer = setInterval(() => {
      setActive((prev) => (prev + 1) % TERMINAL_DEMOS.length)
    }, 4500)
    return () => clearInterval(timer)
  }, [paused])

  const demo = TERMINAL_DEMOS[active]
  const copyText = demo.commands
    .filter((c) => c.cmd)
    .map((c) => c.cmd as string)
    .join('\n')

  return (
    <div
      className="overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="border-b border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex gap-2">
            <span className="size-3 rounded-full bg-zinc-300 dark:bg-zinc-700" />
            <span className="size-3 rounded-full bg-zinc-300 dark:bg-zinc-700" />
            <span className="size-3 rounded-full bg-zinc-300 dark:bg-zinc-700" />
          </div>
          <span className="font-mono text-xs text-zinc-400 dark:text-zinc-500">typeclaw</span>
          <CopyButton text={copyText} />
        </div>
        <div className="flex gap-0 overflow-x-auto px-2">
          {TERMINAL_DEMOS.map((d, i) => (
            <button
              key={d.tab}
              type="button"
              onClick={() => {
                setActive(i)
                setPaused(true)
              }}
              className={`px-3 py-2 font-mono text-xs whitespace-nowrap transition-colors duration-200 ${
                i === active
                  ? 'border-b-2 border-emerald-500 text-zinc-800 dark:text-zinc-200'
                  : 'border-b-2 border-transparent text-zinc-400 hover:text-zinc-600 dark:text-zinc-600 dark:hover:text-zinc-400'
              }`}
            >
              {d.tab}
            </button>
          ))}
        </div>
      </div>

      <pre className="overflow-x-auto p-5 font-mono text-sm leading-relaxed">
        <code>
          {demo.commands.map((line, i) => (
            <span key={`${demo.tab}-${i}`}>
              {line.cmd ? (
                <>
                  <span className="text-zinc-400 dark:text-zinc-500">{line.prompt}</span>
                  <span className="text-zinc-800 dark:text-zinc-100">{line.cmd}</span>
                </>
              ) : (
                <>
                  <span className="text-zinc-400 dark:text-zinc-500">{'  '}</span>
                  <span className="text-emerald-600 dark:text-emerald-400">{line.output}</span>
                </>
              )}
              {i < demo.commands.length - 1 ? '\n' : ''}
            </span>
          ))}
        </code>
      </pre>
    </div>
  )
}

export default function Home() {
  return (
    <div className="min-h-screen bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-[20%] left-1/2 h-[900px] w-[900px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(16,185,129,0.18)_0%,rgba(59,130,246,0.08)_40%,transparent_70%)] opacity-[0.04] dark:opacity-[0.09]" />
        <div className="absolute -right-[5%] -bottom-[10%] h-[600px] w-[600px] rounded-full bg-[radial-gradient(circle,rgba(99,102,241,0.5)_0%,transparent_60%)] opacity-[0.02] dark:opacity-[0.05]" />
      </div>

      <nav className="fixed inset-x-0 top-0 z-50 flex h-16 items-center justify-between border-b border-zinc-200/40 bg-white/80 px-4 backdrop-blur-xl sm:px-6 dark:border-white/[0.06] dark:bg-zinc-950/80">
        <Link
          href="/"
          className="flex items-center gap-2 font-mono text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-100"
        >
          <PawIcon className="size-5 text-emerald-600 dark:text-emerald-400" />
          typeclaw
        </Link>
        <div className="flex items-center gap-1 sm:gap-2">
          <Link
            href="/docs"
            className="rounded-lg px-3 py-2 font-mono text-xs text-zinc-500 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            docs
          </Link>
          <a
            href="https://github.com/typeclaw/typeclaw"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg px-3 py-2 font-mono text-xs text-zinc-500 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            github
          </a>
          <a
            href="https://www.npmjs.com/package/typeclaw"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg px-3 py-2 font-mono text-xs text-zinc-500 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            npm
          </a>
          <ThemeToggle />
        </div>
      </nav>

      <section className="relative z-10 px-4 pt-36 pb-20 sm:px-6 sm:pt-44 sm:pb-24">
        <div className="mx-auto max-w-4xl text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-zinc-200/40 bg-zinc-50/80 px-4 py-1.5 font-mono text-xs tracking-wide text-zinc-600 backdrop-blur-sm dark:border-white/[0.06] dark:bg-white/[0.03] dark:text-zinc-400">
            <span className="size-2 animate-pulse rounded-full bg-emerald-500" />
            open source · MIT
          </div>

          <h1 className="mt-8 text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
            <span className="bg-gradient-to-br from-zinc-900 to-zinc-500 bg-clip-text text-transparent dark:from-white dark:to-zinc-400">
              The TypeScript agent runtime
            </span>
            <br />
            <span className="bg-gradient-to-br from-emerald-600 to-blue-600 bg-clip-text text-transparent dark:from-emerald-400 dark:to-blue-400">
              that fits how you already work
            </span>
          </h1>

          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-zinc-600 dark:text-zinc-400">
            Agent core, plugins, channel adapters, CLI, TUI — all TypeScript. Every agent runs in its own Docker
            container. Plugins are plain TS modules. The agent learns from its own work and gets sharper over time.
          </p>

          <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
            <Link
              href="/docs/quickstart"
              className="inline-flex items-center justify-center rounded-xl bg-zinc-900 px-6 py-3 text-sm font-medium text-white transition-all duration-300 hover:bg-zinc-800 dark:border dark:border-white/15 dark:bg-white/10 dark:backdrop-blur-xl dark:hover:bg-white/15 dark:hover:shadow-[0_0_30px_-5px_rgba(16,185,129,0.25)]"
            >
              Quickstart
            </Link>
            <a
              href="https://github.com/typeclaw/typeclaw"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center rounded-xl border border-zinc-300 px-6 py-3 text-sm font-medium text-zinc-700 transition-all duration-300 hover:bg-zinc-50 dark:border-white/[0.06] dark:text-zinc-300 dark:hover:border-white/15 dark:hover:bg-white/[0.05]"
            >
              View on GitHub
            </a>
          </div>

          <div className="mx-auto mt-14 max-w-2xl text-left">
            <CyclingTerminal />
          </div>
        </div>
      </section>

      <section className="relative z-10 border-y border-zinc-100/50 px-4 py-16 sm:px-6 dark:border-white/[0.04]">
        <div className="mx-auto max-w-5xl">
          <div className="text-center">
            <p className="font-mono text-xs font-medium tracking-widest text-emerald-600 uppercase dark:text-emerald-400">
              Why TypeClaw?
            </p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
              There are great agent runtimes. None of them were quite the shape I wanted.
            </h2>
          </div>

          <div className="mt-12 overflow-x-auto rounded-2xl border border-zinc-200/40 bg-white/50 backdrop-blur-xl dark:border-white/[0.06] dark:bg-white/[0.02]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200/40 dark:border-white/[0.06]">
                  <th className="px-4 py-3 text-left font-mono text-xs font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-500">
                    Runtime
                  </th>
                  <th className="px-4 py-3 text-left font-mono text-xs font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-500">
                    What it gets right
                  </th>
                  <th className="px-4 py-3 text-left font-mono text-xs font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-500">
                    Why it didn't fit
                  </th>
                </tr>
              </thead>
              <tbody>
                {COMPARISONS.map((row, i) => (
                  <tr
                    key={row.runtime}
                    className={i % 2 === 0 ? 'bg-white/30 dark:bg-white/[0.01]' : 'bg-zinc-50/30 dark:bg-transparent'}
                  >
                    <td className="px-4 py-3 font-mono text-sm font-medium whitespace-nowrap text-zinc-700 dark:text-zinc-300">
                      {row.runtime}
                    </td>
                    <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">{row.strength}</td>
                    <td className="px-4 py-3 text-zinc-500 dark:text-zinc-500">{row.weakness}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-emerald-500/30 bg-emerald-50/30 dark:bg-emerald-950/10">
                  <td className="px-4 py-3 font-mono text-sm font-semibold whitespace-nowrap text-emerald-700 dark:text-emerald-400">
                    TypeClaw
                  </td>
                  <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">TypeScript end to end, Bun-native</td>
                  <td className="px-4 py-3 text-zinc-500 dark:text-zinc-500">
                    If you live in the TS ecosystem, nothing
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <p className="mx-auto mt-6 max-w-3xl text-center text-sm text-zinc-500 dark:text-zinc-500">
            None of that matters to most people. It matters if you want one codebase from the entrypoint down to the
            message bus — agent core, plugins, channels, CLI, TUI, all the same language.
          </p>
        </div>
      </section>

      <section className="relative z-10 px-4 py-20 sm:px-6 sm:py-24">
        <div className="mx-auto max-w-5xl">
          <div className="text-center">
            <p className="font-mono text-xs font-medium tracking-widest text-emerald-600 uppercase dark:text-emerald-400">
              What you get
            </p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">Built for agents, sized for humans</h2>
          </div>

          <div className="mt-14 grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6 lg:grid-cols-4">
            {FEATURES.map((f) => (
              <div
                key={f.title}
                className="group rounded-2xl border border-zinc-200/40 bg-white/60 p-6 backdrop-blur-xl transition-all duration-300 hover:border-zinc-300/60 hover:shadow-lg dark:border-white/[0.06] dark:bg-white/[0.03] dark:hover:border-white/15 dark:hover:shadow-[0_0_40px_-15px_rgba(16,185,129,0.18)]"
              >
                <div className="flex size-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600 transition-colors duration-300 dark:bg-emerald-950/40 dark:text-emerald-400">
                  {f.icon}
                </div>
                <h3 className="mt-4 font-mono text-sm font-semibold text-zinc-900 dark:text-zinc-100">{f.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">{f.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="relative z-10 border-t border-zinc-100/50 px-4 py-20 sm:px-6 sm:py-24 dark:border-white/[0.04]">
        <div className="mx-auto max-w-5xl">
          <div className="text-center">
            <p className="font-mono text-xs font-medium tracking-widest text-emerald-600 uppercase dark:text-emerald-400">
              Architecture
            </p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">Three stages, one boundary</h2>
            <p className="mx-auto mt-4 max-w-2xl text-zinc-600 dark:text-zinc-400">
              TypeClaw splits code into three distinct stages, each with a different filesystem and process owner. The
              split is what makes "the agent restarts itself" and "auto port-forward" possible without giving the agent
              the keys to the host.
            </p>
          </div>

          <div className="mt-14 grid grid-cols-1 gap-6 md:grid-cols-3">
            {STAGES.map((stage, i) => (
              <div
                key={stage.name}
                className="relative rounded-2xl border border-zinc-200/40 bg-white/60 p-6 backdrop-blur-xl transition-all duration-300 hover:border-zinc-300/60 dark:border-white/[0.06] dark:bg-white/[0.03] dark:hover:border-white/15"
              >
                <div className="flex items-center gap-3">
                  <span className="flex size-8 items-center justify-center rounded-lg bg-emerald-50 font-mono text-xs font-bold text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <h3 className="font-mono text-sm font-semibold text-zinc-900 dark:text-zinc-100">{stage.name}</h3>
                </div>
                <p className="mt-4 text-sm font-medium text-zinc-700 dark:text-zinc-300">{stage.description}</p>
                <p className="mt-2 text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">{stage.detail}</p>
              </div>
            ))}
          </div>

          <div className="mt-10 rounded-2xl border border-zinc-200/40 bg-white/60 p-6 backdrop-blur-xl dark:border-white/[0.06] dark:bg-white/[0.03]">
            <p className="font-mono text-xs tracking-wide text-zinc-500 dark:text-zinc-500">
              <span className="text-emerald-600 dark:text-emerald-400">hostd</span> — the host-side daemon — is the
              small RPC seam between the host and container stages. It owns container restart, port forwarding, and
              per-host singleton state in ~/.typeclaw/. The container has no Docker access; everything that requires it
              goes through this one channel.
            </p>
          </div>
        </div>
      </section>

      <section className="relative z-10 border-t border-zinc-100/50 px-4 py-20 sm:px-6 sm:py-24 dark:border-white/[0.04]">
        <div className="mx-auto max-w-4xl">
          <div className="text-center">
            <p className="font-mono text-xs font-medium tracking-widest text-emerald-600 uppercase dark:text-emerald-400">
              Self-improving memory
            </p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">Observe. Dream. Apply.</h2>
            <p className="mx-auto mt-4 max-w-2xl text-zinc-600 dark:text-zinc-400">
              The bundled <code className="font-mono text-emerald-700 dark:text-emerald-400">memory</code> plugin turns
              lived experience into reusable knowledge. No manual prompt engineering. No curated example library.
            </p>
          </div>

          <div className="mt-14 space-y-6">
            <div className="rounded-2xl border border-zinc-200/40 bg-white/60 p-6 backdrop-blur-xl dark:border-white/[0.06] dark:bg-white/[0.03]">
              <div className="flex items-start gap-4">
                <span className="flex size-9 flex-shrink-0 items-center justify-center rounded-lg bg-emerald-50 font-mono text-sm font-bold text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400">
                  1
                </span>
                <div>
                  <h3 className="font-mono text-sm font-semibold text-zinc-900 dark:text-zinc-100">Observe</h3>
                  <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                    After every idle turn, a{' '}
                    <code className="font-mono text-zinc-700 dark:text-zinc-300">memory-logger</code> subagent reads the
                    transcript and appends notable fragments to{' '}
                    <code className="font-mono text-zinc-700 dark:text-zinc-300">memory/yyyy-MM-dd.md</code>. Cheap,
                    frequent, lossy by design.
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-zinc-200/40 bg-white/60 p-6 backdrop-blur-xl dark:border-white/[0.06] dark:bg-white/[0.03]">
              <div className="flex items-start gap-4">
                <span className="flex size-9 flex-shrink-0 items-center justify-center rounded-lg bg-emerald-50 font-mono text-sm font-bold text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400">
                  2
                </span>
                <div>
                  <h3 className="font-mono text-sm font-semibold text-zinc-900 dark:text-zinc-100">Dream</h3>
                  <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                    On a cron schedule (default 4am), a{' '}
                    <code className="font-mono text-zinc-700 dark:text-zinc-300">dreaming</code> subagent consolidates
                    daily streams into <code className="font-mono text-zinc-700 dark:text-zinc-300">MEMORY.md</code>,
                    and — when it spots a procedure worth remembering — writes it as muscle memory: a new skill at{' '}
                    <code className="font-mono text-zinc-700 dark:text-zinc-300">
                      memory/skills/&lt;name&gt;/SKILL.md
                    </code>
                    .
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-zinc-200/40 bg-white/60 p-6 backdrop-blur-xl dark:border-white/[0.06] dark:bg-white/[0.03]">
              <div className="flex items-start gap-4">
                <span className="flex size-9 flex-shrink-0 items-center justify-center rounded-lg bg-emerald-50 font-mono text-sm font-bold text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400">
                  3
                </span>
                <div>
                  <h3 className="font-mono text-sm font-semibold text-zinc-900 dark:text-zinc-100">Apply</h3>
                  <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                    Tomorrow's prompt sees the updated{' '}
                    <code className="font-mono text-zinc-700 dark:text-zinc-300">MEMORY.md</code>. Muscle-memory skills
                    sit alongside bundled and user-installed ones, loaded on demand. Every dream is committed with a
                    one-line summary — e.g.{' '}
                    <code className="font-mono text-zinc-700 dark:text-zinc-300">
                      dream: 3 fragments + new skill 'pr-review' 🔮
                    </code>{' '}
                    — so growth is auditable.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="relative z-10 border-t border-zinc-100/50 px-4 py-20 sm:px-6 sm:py-24 dark:border-white/[0.04]">
        <div className="mx-auto max-w-2xl">
          <div className="relative overflow-hidden rounded-3xl border border-zinc-200/40 bg-white/60 p-10 text-center backdrop-blur-xl dark:border-white/[0.08] dark:bg-white/[0.03]">
            <div className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_center,rgba(16,185,129,0.1)_0%,transparent_60%)] opacity-0 dark:opacity-100" />

            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Get your agent running</h2>
            <p className="mt-4 text-zinc-600 dark:text-zinc-400">Requires Bun ≥ 1.1 and Docker or OrbStack.</p>

            <div className="mx-auto mt-10 max-w-lg text-left">
              <TerminalBlock copyText="bun add -g typeclaw">
                <span className="text-zinc-400 dark:text-zinc-500">$ </span>
                <span className="text-zinc-800 dark:text-zinc-100">bun add -g typeclaw</span>
              </TerminalBlock>
            </div>

            <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
              <Link
                href="/docs/quickstart"
                className="inline-flex items-center justify-center rounded-xl bg-zinc-900 px-6 py-3 text-sm font-medium text-white transition-all duration-300 hover:bg-zinc-800 dark:border dark:border-white/15 dark:bg-white/10 dark:backdrop-blur-xl dark:hover:bg-white/15"
              >
                Read the Quickstart
              </Link>
              <a
                href="https://github.com/typeclaw/typeclaw"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center rounded-xl border border-zinc-300 px-6 py-3 text-sm font-medium text-zinc-700 transition-all duration-300 hover:bg-white dark:border-white/[0.06] dark:text-zinc-300 dark:hover:border-white/15 dark:hover:bg-white/[0.05]"
              >
                View on GitHub
              </a>
            </div>
          </div>
        </div>
      </section>

      <footer className="relative z-10 border-t border-zinc-200/40 px-4 py-12 dark:border-white/[0.06]">
        <div className="mx-auto max-w-5xl text-center">
          <div className="flex items-center justify-center gap-6 font-mono text-xs text-zinc-400 dark:text-zinc-600">
            <Link href="/docs" className="transition-colors duration-300 hover:text-zinc-700 dark:hover:text-zinc-300">
              docs
            </Link>
            <a
              href="https://github.com/typeclaw/typeclaw"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors duration-300 hover:text-zinc-700 dark:hover:text-zinc-300"
            >
              github
            </a>
            <a
              href="https://www.npmjs.com/package/typeclaw"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors duration-300 hover:text-zinc-700 dark:hover:text-zinc-300"
            >
              npm
            </a>
          </div>
          <p className="mt-6 font-mono text-xs text-zinc-400 dark:text-zinc-600">
            &copy; {new Date().getFullYear()} typeclaw · MIT
          </p>
        </div>
      </footer>
    </div>
  )
}
