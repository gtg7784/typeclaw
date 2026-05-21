'use client'

import { useTheme } from 'next-themes'
import Image from 'next/image'
import Link from 'next/link'
import { useEffect, useState } from 'react'

import logo from './icon.png'

const INSTALL_COMMAND = 'bun add -g typeclaw'

interface Feature {
  title: string
  detail: string
}

const FEATURES: Feature[] = [
  { title: 'Sandboxed by default', detail: 'every agent runs in its own Docker container' },
  { title: 'TypeScript end to end', detail: 'core, plugins, channels, CLI, TUI' },
  { title: 'Bun-native plugins', detail: 'plain .ts modules; no IPC, no FFI' },
  { title: 'Multi-channel', detail: 'Slack, Discord, Telegram, KakaoTalk, GitHub, TUI' },
  { title: 'Cron', detail: 'scheduled prompts and shell commands, with coalescing' },
  { title: 'Self-improving memory', detail: 'observes its own work and writes its own skills' },
  { title: 'Hot reload', detail: 'edit typeclaw.json, run typeclaw reload' },
  { title: 'Auto port-forward', detail: 'dev servers in the container appear on localhost' },
  { title: 'Public tunnels', detail: 'Cloudflare Quick or your own URL — built in' },
  { title: 'Skills on demand', detail: 'markdown procedures with zero token cost until used' },
  { title: 'Group-chat aware', detail: 'knows who is in the room and when to reply' },
  { title: 'Roles and permissions', detail: 'platform-aware match rules gate every action' },
]

interface DocLink {
  href: string
  title: string
  blurb: string
}

const DOC_LINKS: DocLink[] = [
  { href: '/docs/quickstart', title: 'Quickstart', blurb: 'install through first cron in under a minute' },
  { href: '/docs/configuration', title: 'Configuration', blurb: 'every field in typeclaw.json' },
  { href: '/docs/plugins', title: 'Plugins', blurb: 'write your first plugin' },
  { href: '/docs/channels', title: 'Channels', blurb: 'wire Slack, Discord, Telegram, GitHub' },
  { href: '/docs/memory', title: 'Memory', blurb: 'how the agent learns over time' },
  { href: '/docs/secrets', title: 'Secrets', blurb: '.env vs secrets.json, env-wins policy' },
]

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1800)
        })
      }}
      className="flex shrink-0 items-center justify-center rounded-md p-2 text-zinc-400 transition-colors hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-200"
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
      className="flex size-9 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
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

function InstallBlock() {
  return (
    <div className="mx-auto flex w-full max-w-xl items-center justify-between gap-2 rounded-2xl border border-zinc-200 bg-zinc-50 py-2 pr-2 pl-5 font-mono text-sm text-zinc-800 shadow-[0_1px_0_0_rgba(0,0,0,0.02)] dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-zinc-100">
      <span className="select-none text-zinc-400 dark:text-zinc-600">$</span>
      <span className="flex-1 truncate">{INSTALL_COMMAND}</span>
      <CopyButton text={INSTALL_COMMAND} />
    </div>
  )
}

function ExampleBlock() {
  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-[0_1px_0_0_rgba(0,0,0,0.02)] dark:border-white/[0.08] dark:bg-zinc-950">
      <div className="flex items-center justify-between border-b border-zinc-100 bg-zinc-50 px-4 py-2.5 dark:border-white/[0.04] dark:bg-white/[0.02]">
        <div className="flex gap-1.5">
          <span className="size-2.5 rounded-full bg-zinc-300 dark:bg-zinc-700" />
          <span className="size-2.5 rounded-full bg-zinc-300 dark:bg-zinc-700" />
          <span className="size-2.5 rounded-full bg-zinc-300 dark:bg-zinc-700" />
        </div>
        <span className="font-mono text-xs text-zinc-400 dark:text-zinc-600">my-agent</span>
        <span className="size-2.5" />
      </div>
      <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-relaxed">
        <code>
          <span className="text-zinc-400 dark:text-zinc-600">$ </span>
          <span className="text-zinc-800 dark:text-zinc-100">typeclaw init</span>
          {'\n'}
          <span className="text-cyan-700 dark:text-cyan-400">✓</span>
          <span className="text-zinc-600 dark:text-zinc-400"> wrote typeclaw.json, .env, Dockerfile</span>
          {'\n\n'}
          <span className="text-zinc-400 dark:text-zinc-600">$ </span>
          <span className="text-zinc-800 dark:text-zinc-100">typeclaw start</span>
          {'\n'}
          <span className="text-cyan-700 dark:text-cyan-400">✓</span>
          <span className="text-zinc-600 dark:text-zinc-400"> container my-agent up on :8973</span>
          {'\n\n'}
          <span className="text-zinc-400 dark:text-zinc-600">$ </span>
          <span className="text-zinc-800 dark:text-zinc-100">typeclaw channel add slack-bot</span>
          {'\n'}
          <span className="text-cyan-700 dark:text-cyan-400">✓</span>
          <span className="text-zinc-600 dark:text-zinc-400"> answering in #standup as @typeclaw</span>
          {'\n\n'}
          <span className="text-zinc-400 dark:text-zinc-600">$ </span>
          <span className="text-zinc-800 dark:text-zinc-100">git log memory/ --oneline</span>
          {'\n'}
          <span className="text-zinc-500">a3f2c1d </span>
          <span className="text-zinc-600 dark:text-zinc-400">dream: 4 fragments + new skill {`'pr-review'`} 🔮</span>
        </code>
      </pre>
    </div>
  )
}

function FeatureItem({ feature }: { feature: Feature }) {
  return (
    <li className="flex items-baseline gap-3 py-2.5">
      <span aria-hidden className="font-mono text-xs text-cyan-600 dark:text-cyan-400">
        ✦
      </span>
      <div className="text-sm leading-relaxed">
        <span className="font-medium text-zinc-900 dark:text-zinc-100">{feature.title}</span>
        <span className="text-zinc-500 dark:text-zinc-400"> — {feature.detail}</span>
      </div>
    </li>
  )
}

export default function Home() {
  return (
    <div className="min-h-screen bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <nav className="sticky top-0 z-50 flex h-14 items-center justify-between border-b border-zinc-100 bg-white/85 px-5 backdrop-blur-md sm:px-8 dark:border-white/[0.06] dark:bg-zinc-950/85">
        <Link href="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <Image src={logo} alt="TypeClaw" width={22} height={22} className="rounded-md" priority />
          typeclaw
        </Link>
        <div className="flex items-center gap-1 sm:gap-2">
          <Link
            href="/docs"
            className="rounded-md px-2.5 py-1.5 text-sm text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            docs
          </Link>
          <a
            href="https://github.com/typeclaw/typeclaw"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md px-2.5 py-1.5 text-sm text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            github
          </a>
          <a
            href="https://www.npmjs.com/package/typeclaw"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md px-2.5 py-1.5 text-sm text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            npm
          </a>
          <ThemeToggle />
        </div>
      </nav>

      <main>
        <section className="mx-auto max-w-3xl px-6 pt-24 pb-16 text-center sm:pt-32 sm:pb-20">
          <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
            A TypeScript agent runtime,
            <br />
            <span className="text-cyan-700 dark:text-cyan-400">with batteries included.</span>
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-balance text-base leading-relaxed text-zinc-600 sm:text-lg dark:text-zinc-400">
            Scaffold an AI agent in a folder. It runs in its own Docker container, talks to you in a terminal, and wires
            into Slack or Discord when you tell it to.
          </p>
          <div className="mt-10">
            <InstallBlock />
          </div>
        </section>

        <section className="mx-auto max-w-4xl px-6 pb-16 sm:pb-20">
          <h2 className="text-center text-xs font-medium tracking-[0.18em] text-zinc-400 uppercase dark:text-zinc-500">
            What you get
          </h2>
          <ul className="mt-8 grid grid-cols-1 gap-x-10 gap-y-0 sm:grid-cols-2">
            {FEATURES.map((feature) => (
              <FeatureItem key={feature.title} feature={feature} />
            ))}
          </ul>
        </section>

        <section className="mx-auto max-w-3xl px-6 pb-16 sm:pb-20">
          <h2 className="text-center text-xs font-medium tracking-[0.18em] text-zinc-400 uppercase dark:text-zinc-500">
            One minute, end to end
          </h2>
          <div className="mt-8">
            <ExampleBlock />
          </div>
          <p className="mx-auto mt-6 max-w-2xl text-center text-sm text-zinc-500 dark:text-zinc-500">
            Four commands. The agent is live in its own container, answering in Slack, and has already started building
            its own memory.
          </p>
        </section>

        <section className="mx-auto max-w-4xl px-6 pb-16 sm:pb-20">
          <h2 className="text-center text-xs font-medium tracking-[0.18em] text-zinc-400 uppercase dark:text-zinc-500">
            Read more
          </h2>
          <ul className="mt-8 grid grid-cols-1 gap-x-10 gap-y-1 sm:grid-cols-2">
            {DOC_LINKS.map((doc) => (
              <li key={doc.href}>
                <Link
                  href={doc.href}
                  className="group flex items-baseline gap-3 rounded-md py-2.5 transition-colors hover:bg-zinc-50 dark:hover:bg-white/[0.03]"
                >
                  <span
                    aria-hidden
                    className="font-mono text-xs text-zinc-300 transition-colors group-hover:text-cyan-600 dark:text-zinc-700 dark:group-hover:text-cyan-400"
                  >
                    →
                  </span>
                  <span className="text-sm">
                    <span className="font-medium text-zinc-900 group-hover:text-cyan-700 dark:text-zinc-100 dark:group-hover:text-cyan-300">
                      {doc.title}
                    </span>
                    <span className="text-zinc-500 dark:text-zinc-400"> — {doc.blurb}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer className="border-t border-zinc-100 px-6 py-10 dark:border-white/[0.04]">
        <div className="mx-auto flex max-w-4xl flex-col items-center gap-4 text-xs text-zinc-400 sm:flex-row sm:justify-between dark:text-zinc-600">
          <div className="flex items-center gap-2">
            <Image src={logo} alt="" width={16} height={16} className="rounded-sm opacity-70" />
            <span>typeclaw · MIT · {new Date().getFullYear()}</span>
          </div>
          <div className="flex items-center gap-5">
            <Link href="/docs" className="transition-colors hover:text-zinc-700 dark:hover:text-zinc-300">
              docs
            </Link>
            <a
              href="https://github.com/typeclaw/typeclaw"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-zinc-700 dark:hover:text-zinc-300"
            >
              github
            </a>
            <a
              href="https://www.npmjs.com/package/typeclaw"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-zinc-700 dark:hover:text-zinc-300"
            >
              npm
            </a>
          </div>
        </div>
      </footer>
    </div>
  )
}
