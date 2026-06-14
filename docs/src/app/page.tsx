import { ArrowRight, BookOpen, Check, Container, Github, Lock, Minus, Shield, Sparkles, Star, X } from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'

import { AnimatedTerminal } from './_components/animated-terminal'
import { CHANNELS } from './_components/channel-icons'
import { CopyButton } from './_components/copy-button'
import { COMPARISON_FEATURES, COMPETITORS, INSTALL_COMMAND, MEMORY_LOOP, VERSION } from './_components/data'
import { FEATURE_CATEGORIES } from './_components/features-data'
import { HeroSpotlight } from './_components/hero-spotlight'
import { Reveal } from './_components/reveal'
import { ThemeToggle } from './_components/theme-toggle'
import { UseCaseTabs } from './_components/use-case-tabs'

const PLUGIN_CODE = `import { definePlugin } from 'typeclaw/plugin'
import { z } from 'zod'

export default definePlugin({
  configSchema: z.object({ webhook: z.string().url() }),
  async plugin(ctx) {
    const { webhook } = ctx.config
    return {
      tools: {
        notify: {
          description: 'Post a short notification',
          parameters: z.object({ text: z.string() }),
          async execute({ text }) {
            await fetch(webhook, { method: 'POST', body: text })
            return { content: [{ type: 'text', text: 'sent' }] }
          },
        },
      },
    }
  },
})`

function HeroInstall() {
  return (
    <div className="group relative mx-auto w-full max-w-xl">
      <div
        aria-hidden
        className="absolute -inset-px rounded-2xl bg-gradient-to-r from-brand-400/30 via-brand-200/40 to-brand-400/30 opacity-70 blur-md transition-opacity group-hover:opacity-100 dark:from-brand-700/40 dark:via-brand-500/30 dark:to-brand-700/40"
      />
      <div className="relative flex items-center justify-between gap-2 rounded-2xl border border-zinc-200 bg-white py-3 pr-2 pl-4 font-mono text-xs sm:pl-5 sm:text-sm text-zinc-800 shadow-lg dark:border-white/[0.1] dark:bg-zinc-950 dark:text-zinc-100">
        <span className="text-zinc-400 dark:text-zinc-600" aria-hidden>
          $
        </span>
        <span className="min-w-0 flex-1 truncate">{INSTALL_COMMAND}</span>
        <CopyButton text={INSTALL_COMMAND} />
      </div>
    </div>
  )
}

function DotGrid() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10 opacity-[0.45] dark:opacity-[0.25]"
      style={{
        backgroundImage: 'radial-gradient(circle at center, currentColor 1px, transparent 1px)',
        backgroundSize: '24px 24px',
        color: 'rgba(54, 72, 132, 0.18)',
        maskImage: 'radial-gradient(ellipse 80% 60% at 50% 0%, black 30%, transparent 75%)',
        WebkitMaskImage: 'radial-gradient(ellipse 80% 60% at 50% 0%, black 30%, transparent 75%)',
      }}
    />
  )
}

function ChannelTrust() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col items-center gap-5">
      <p className="text-xs tracking-[0.2em] text-zinc-500 uppercase dark:text-zinc-500">
        Talks to — and a websocket TUI
      </p>
      <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-4">
        {CHANNELS.map(({ name, Icon, href }) => {
          const className =
            'flex items-center gap-2 text-zinc-500 grayscale transition-all hover:text-zinc-800 hover:grayscale-0 dark:text-zinc-500 dark:hover:text-zinc-200'
          const content = (
            <>
              <Icon className="size-5" />
              <span className="text-sm font-medium">{name}</span>
            </>
          )
          return href ? (
            <Link key={name} href={href} className={className}>
              {content}
            </Link>
          ) : (
            <div key={name} className={className}>
              {content}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function SandboxDiagram() {
  return (
    <div className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl border border-zinc-200 bg-gradient-to-br from-zinc-50 to-white p-5 sm:p-8 dark:border-white/[0.08] dark:from-white/[0.03] dark:to-zinc-950">
      <div className="relative flex h-full items-center justify-center">
        <div className="relative w-full max-w-xs">
          <div className="absolute -inset-4 rounded-2xl border-2 border-dashed border-zinc-300 dark:border-white/[0.1]" />
          <div className="absolute -top-3 left-4 bg-white px-2 font-mono text-[10px] tracking-widest text-zinc-400 uppercase dark:bg-zinc-950 dark:text-zinc-600">
            your machine
          </div>
          <div className="relative rounded-xl border border-brand-200 bg-white p-5 shadow-lg dark:border-brand-800/60 dark:bg-zinc-900">
            <div className="absolute -top-3 left-4 inline-flex items-center gap-1.5 rounded-md bg-brand-700 px-2 py-0.5 font-mono text-[10px] tracking-wider text-white uppercase dark:bg-brand-600">
              <Container className="size-3" strokeWidth={2.4} aria-hidden />
              docker
            </div>
            <p className="mt-2 text-sm font-semibold text-zinc-800 dark:text-zinc-100">my-agent</p>
            <ul className="mt-3 space-y-1.5 font-mono text-xs text-zinc-500 dark:text-zinc-500">
              <li>~ typeclaw run</li>
              <li>~ /agent mounted</li>
              <li>~ slack-bot · up</li>
              <li>~ cron · 3 jobs</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}

function PluginCode() {
  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-lg dark:border-white/[0.08] dark:bg-zinc-950">
      <div className="flex items-center justify-between border-b border-zinc-100 bg-zinc-50 px-4 py-2.5 dark:border-white/[0.04] dark:bg-white/[0.02]">
        <div className="flex gap-1.5">
          <span className="size-2.5 rounded-full bg-zinc-300 dark:bg-zinc-700" />
          <span className="size-2.5 rounded-full bg-zinc-300 dark:bg-zinc-700" />
          <span className="size-2.5 rounded-full bg-zinc-300 dark:bg-zinc-700" />
        </div>
        <span className="font-mono text-xs text-zinc-400 dark:text-zinc-600">plugins/pr-review.ts</span>
        <span className="size-2.5" />
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-xs leading-relaxed text-zinc-700 sm:p-5 sm:text-[13px] dark:text-zinc-300">
        <code>{PLUGIN_CODE}</code>
      </pre>
    </div>
  )
}

function CapabilityGrid() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {FEATURE_CATEGORIES.filter((c) => c.featured).map(({ id, icon: Icon, title, summary }) => (
        <div
          key={id}
          className="group rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm transition-all hover:translate-y-[-2px] hover:border-brand-200 hover:shadow-md dark:border-white/[0.08] dark:bg-white/[0.02] dark:hover:border-brand-800/60"
        >
          <div className="inline-flex size-10 items-center justify-center rounded-xl bg-brand-50 text-brand-700 transition-colors group-hover:bg-brand-100 dark:bg-brand-950/60 dark:text-brand-300 dark:group-hover:bg-brand-900/60">
            <Icon className="size-5" strokeWidth={2.2} aria-hidden />
          </div>
          <h3 className="mt-4 text-base font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">{title}</h3>
          <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">{summary}</p>
        </div>
      ))}
    </div>
  )
}

function MemoryLoopVertical() {
  return (
    <div className="relative">
      <ol className="space-y-1">
        {MEMORY_LOOP.map((stage, i) => (
          <li key={stage.label} className="relative pl-12">
            <div className="absolute top-0 left-0 flex size-9 items-center justify-center rounded-full border-2 border-brand-200 bg-white font-mono text-xs font-semibold text-brand-700 dark:border-brand-800/60 dark:bg-zinc-950 dark:text-brand-300">
              {i + 1}
            </div>
            {i < MEMORY_LOOP.length - 1 && (
              <div
                aria-hidden
                className="absolute top-9 left-[18px] h-12 w-px bg-gradient-to-b from-brand-300 to-brand-100 dark:from-brand-700 dark:to-brand-900/30"
              />
            )}
            <div className="pb-6">
              <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{stage.label}</p>
              <p className="mt-1 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">{stage.blurb}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-2 inline-flex items-center gap-2 rounded-full bg-brand-50 px-3 py-1 text-xs font-medium text-brand-700 dark:bg-brand-950/60 dark:text-brand-300">
        <ArrowRight className="size-3.5 -rotate-90" strokeWidth={2.4} aria-hidden />
        loops back into the next session log
      </div>
    </div>
  )
}

function CheckCell({ value }: { value: boolean | 'partial' }) {
  if (value === 'partial') {
    return (
      <span className="inline-flex items-center justify-center text-zinc-400 dark:text-zinc-600">
        <Minus className="size-4" strokeWidth={2.5} aria-hidden />
        <span className="sr-only">Partial</span>
      </span>
    )
  }
  return value ? (
    <span className="inline-flex items-center justify-center text-brand-600 dark:text-brand-400">
      <Check className="size-[18px]" strokeWidth={2.75} aria-hidden />
      <span className="sr-only">Yes</span>
    </span>
  ) : (
    <span className="inline-flex items-center justify-center text-zinc-300 dark:text-zinc-700">
      <X className="size-4" strokeWidth={2.25} aria-hidden />
      <span className="sr-only">No</span>
    </span>
  )
}

function MarketingTable() {
  const lastFeatureIndex = COMPARISON_FEATURES.length - 1
  return (
    <div className="overflow-x-auto rounded-2xl border border-zinc-200 dark:border-white/[0.08]">
      <table className="w-full min-w-[680px] border-separate border-spacing-0 text-left text-sm">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 border-b border-zinc-200 bg-white px-5 pt-6 pb-5 align-bottom font-mono text-[11px] font-medium tracking-[0.14em] text-zinc-400 uppercase dark:border-white/[0.08] dark:bg-zinc-950">
              Feature
            </th>
            {COMPETITORS.map((r) => (
              <th
                key={r.name}
                className={`border-b px-4 pt-6 pb-5 text-center align-top ${
                  r.highlight
                    ? 'border-brand-200 bg-brand-50/50 dark:border-brand-900/50 dark:bg-brand-950/30'
                    : 'border-zinc-200 dark:border-white/[0.08]'
                }`}
              >
                <div className="flex items-center justify-center gap-2">
                  <span
                    className={
                      r.highlight
                        ? 'text-base font-semibold tracking-tight text-brand-700 dark:text-brand-200'
                        : 'text-base font-semibold tracking-tight text-zinc-800 dark:text-zinc-200'
                    }
                  >
                    {r.name}
                  </span>
                  {r.highlight && (
                    <span className="rounded-full bg-brand-600 px-2 py-0.5 font-mono text-[9px] font-semibold tracking-wider text-white uppercase dark:bg-brand-500">
                      you are here
                    </span>
                  )}
                </div>
                <div className="mt-1.5 font-mono text-[11px] font-normal tracking-normal text-zinc-400 normal-case dark:text-zinc-500">
                  {r.lang}
                </div>
                <p className="mx-auto mt-2 max-w-[13rem] text-xs font-normal leading-snug tracking-normal text-zinc-500 normal-case dark:text-zinc-500">
                  {r.strength} · {r.tradeoff}
                </p>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {COMPARISON_FEATURES.map((feature, i) => {
            const lastRow = i === lastFeatureIndex
            const border = lastRow ? '' : 'border-b border-zinc-100 dark:border-white/[0.06]'
            return (
              <tr key={feature.key}>
                <th
                  scope="row"
                  className={`sticky left-0 z-10 bg-white px-5 py-4 text-left text-[13px] font-medium whitespace-nowrap text-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 ${border}`}
                >
                  {feature.label}
                </th>
                {COMPETITORS.map((r) => (
                  <td
                    key={r.name}
                    className={`px-4 py-4 text-center align-middle ${border} ${
                      r.highlight ? 'bg-brand-50/50 dark:bg-brand-950/30' : ''
                    }`}
                  >
                    <CheckCell value={r[feature.key]} />
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

interface FeatureRowProps {
  eyebrow: string
  title: string
  blurb: string
  reverse?: boolean
  visual: React.ReactNode
}

function FeatureRow({ eyebrow, title, blurb, reverse, visual }: FeatureRowProps) {
  return (
    <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-2 lg:gap-16">
      <div className={reverse ? 'min-w-0 lg:order-2' : 'min-w-0'}>
        <p className="font-mono text-xs tracking-[0.2em] text-brand-700 uppercase dark:text-brand-300">{eyebrow}</p>
        <h3 className="mt-3 text-balance text-4xl font-semibold tracking-tight sm:text-5xl">{title}</h3>
        <p className="mt-4 max-w-md text-base leading-relaxed text-zinc-600 dark:text-zinc-400">{blurb}</p>
      </div>
      <div className={reverse ? 'min-w-0 lg:order-1' : 'min-w-0'}>{visual}</div>
    </div>
  )
}

function PermissionsVisual() {
  return (
    <div className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl border border-zinc-200 bg-gradient-to-br from-zinc-50 to-white p-5 sm:p-8 dark:border-white/[0.08] dark:from-white/[0.03] dark:to-zinc-950">
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <div className="flex items-center gap-3 rounded-xl border border-brand-200 bg-white px-5 py-3 shadow-sm dark:border-brand-800/60 dark:bg-zinc-900">
          <Shield className="size-5 text-brand-600 dark:text-brand-300" strokeWidth={2.4} />
          <div className="text-sm font-medium text-zinc-800 dark:text-zinc-100">Owner → Full access</div>
        </div>
        <div className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-white px-5 py-3 shadow-sm dark:border-white/[0.08] dark:bg-zinc-900">
          <Lock className="size-5 text-zinc-400 dark:text-zinc-600" strokeWidth={2.4} />
          <div className="text-sm font-medium text-zinc-800 dark:text-zinc-100">Guest → Read only</div>
        </div>
      </div>
    </div>
  )
}

function LiveProof() {
  return (
    <div className="mx-auto max-w-3xl">
      <div className="relative overflow-hidden rounded-2xl border border-brand-100 bg-gradient-to-br from-brand-50/80 to-white p-10 text-center dark:border-brand-900/40 dark:from-brand-950/40 dark:to-zinc-950">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 font-mono text-[11px] font-medium tracking-wider text-emerald-700 uppercase dark:bg-emerald-900/30 dark:text-emerald-300">
          <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" aria-hidden />
          Live right now
        </span>
        <p className="mx-auto mt-6 max-w-xl text-balance text-xl font-medium leading-relaxed text-zinc-800 dark:text-zinc-100 sm:text-2xl">
          This page&apos;s mascot reviews real pull requests on TypeClaw&apos;s own repo — unprompted, line by line.
        </p>
        <p className="mx-auto mt-4 max-w-lg text-balance text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
          Request{' '}
          <a
            href="https://github.com/typeey"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-brand-700 underline-offset-2 hover:underline dark:text-brand-300"
          >
            @typeey
          </a>{' '}
          as a reviewer and it reads the diff, thinks it through, and posts a formal review back. No human pressing a
          button. The whole setup is one recipe you can copy.
        </p>
        <div className="mt-7">
          <Link
            href="/docs/recipes/code-reviewer"
            className="inline-flex items-center gap-2 rounded-xl border border-brand-200 bg-white px-5 py-2.5 text-sm font-medium text-brand-800 shadow-sm transition-all hover:translate-y-[-1px] hover:shadow-md dark:border-brand-800/60 dark:bg-zinc-900 dark:text-brand-200"
          >
            See how it&apos;s wired
            <ArrowRight className="size-4" strokeWidth={2.4} aria-hidden />
          </Link>
        </div>
      </div>
    </div>
  )
}

export default function Home() {
  return (
    <div className="min-h-screen overflow-x-clip bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <nav className="sticky top-0 z-50 border-b border-zinc-100 bg-white/85 backdrop-blur-md dark:border-white/[0.06] dark:bg-zinc-950/85">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-5 sm:px-8">
          <Link href="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <div className="relative">
              <Image src="/typeclaw.png" alt="TypeClaw" width={22} height={22} className="rounded-md" />
              <span
                aria-hidden
                className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-emerald-500 ring-2 ring-white dark:ring-zinc-950"
              />
            </div>
            typeclaw
            <span className="ml-1 rounded-md bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500 dark:bg-white/[0.06] dark:text-zinc-400">
              {VERSION}
            </span>
          </Link>
          <div className="flex items-center gap-1 sm:gap-2">
            <Link
              href="/docs"
              className="rounded-md px-2.5 py-1.5 text-sm text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              Docs
            </Link>
            <a
              href="https://github.com/typeclaw/typeclaw"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md px-2.5 py-1.5 text-sm text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              GitHub
            </a>
            <ThemeToggle />
          </div>
        </div>
      </nav>

      <main>
        <section className="relative overflow-hidden">
          <DotGrid />
          <HeroSpotlight>
            <div className="relative z-10 mx-auto max-w-4xl px-5 pt-16 pb-24 sm:px-6 sm:pb-32 text-center sm:pt-24">
              <div className="inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white/60 px-3 py-1 text-xs font-medium text-zinc-600 backdrop-blur dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-zinc-400">
                <Sparkles className="size-3.5 text-brand-600 dark:text-brand-300" strokeWidth={2.4} aria-hidden />
                {VERSION} · crafted in every detail
              </div>
              <div className="relative mt-8">
                <Image
                  src="/typeey-cutout.png"
                  alt=""
                  width={895}
                  height={858}
                  aria-hidden
                  priority
                  className="pointer-events-none absolute top-1/2 right-[-60px] -z-10 hidden w-44 -translate-y-1/2 -rotate-6 select-none lg:block xl:right-[-80px] xl:w-52"
                />
                <h1 className="text-balance text-5xl font-semibold tracking-tight min-[380px]:text-6xl sm:text-7xl lg:text-8xl">
                  The agent for
                  <br />
                  <span className="hero-lit-text">perfectionists.</span>
                </h1>
              </div>
              <p className="mx-auto mt-7 max-w-xl text-balance text-lg leading-relaxed text-zinc-600 dark:text-zinc-400">
                Crafted in every detail — it behaves in your team&apos;s chat and gets sharper the longer it runs.
                Sandboxed and self-managing.
              </p>
              <div className="mt-10">
                <HeroInstall />
              </div>
              <div className="mt-6 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
                <Link
                  href="/docs/guides/quickstart"
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-brand-700 px-5 py-3 text-sm font-medium text-white shadow-sm transition-all hover:translate-y-[-1px] hover:bg-brand-800 hover:shadow-md dark:bg-brand-600 dark:hover:bg-brand-500"
                >
                  Start in 5 minutes
                  <ArrowRight className="size-4" strokeWidth={2.4} aria-hidden />
                </Link>
                <a
                  href="https://github.com/typeclaw/typeclaw"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-300 bg-white px-5 py-3 text-sm font-medium text-zinc-800 transition-all hover:border-zinc-400 hover:shadow-sm dark:border-white/[0.12] dark:bg-white/[0.02] dark:text-zinc-200 dark:hover:border-white/[0.2]"
                >
                  <Star className="size-4" strokeWidth={2.4} aria-hidden />
                  Star on GitHub
                </a>
              </div>
            </div>
          </HeroSpotlight>
        </section>

        <section className="border-y border-zinc-100 bg-zinc-50/50 py-16 dark:border-white/[0.04] dark:bg-white/[0.01]">
          <Reveal>
            <ChannelTrust />
          </Reveal>
        </section>

        <section className="mx-auto max-w-6xl px-5 py-24 sm:px-6 sm:py-36">
          <Reveal className="mb-12 text-center">
            <p className="font-mono text-xs tracking-[0.2em] text-brand-700 uppercase dark:text-brand-300">
              everything it does
            </p>
            <h2 className="mt-3 text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
              Features crafted for perfectionists.
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-zinc-600 dark:text-zinc-400">
              From a self-improving memory loop to a sandbox per agent, here is the whole surface — one capability per
              card.
            </p>
          </Reveal>
          <Reveal delay={120}>
            <CapabilityGrid />
          </Reveal>
        </section>

        <section className="mx-auto max-w-6xl px-5 py-24 sm:px-6 sm:py-36">
          <Reveal className="text-center">
            <p className="font-mono text-xs tracking-[0.2em] text-brand-700 uppercase dark:text-brand-300">
              Memory you can read
            </p>
            <h2 className="mt-3 text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
              It gets sharper while you sleep — and you can read every word it learned.
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-zinc-600 dark:text-zinc-400">
              A dreaming subagent distills each day&apos;s work into long-term memory and reusable skills. It all lands
              as plain files, committed to git — so you can review what it picked up, revert what it got wrong, and own
              its memory like the rest of your code. Self-improving, never a black box.
            </p>
          </Reveal>
          <Reveal className="mx-auto mt-12 max-w-lg" delay={120}>
            <div className="rounded-2xl border border-brand-100 bg-gradient-to-br from-brand-50/80 to-white p-8 dark:border-brand-900/40 dark:from-brand-950/40 dark:to-zinc-950">
              <MemoryLoopVertical />
            </div>
          </Reveal>
        </section>

        <section className="mx-auto max-w-6xl space-y-24 px-5 py-24 sm:space-y-36 sm:px-6 sm:py-36">
          <Reveal>
            <FeatureRow
              eyebrow="Plugins are just imports"
              title="Extend it from inside the language you already use."
              blurb="No plugin DSL, no IPC, no FFI, no sidecar process. A plugin is a plain .ts file that imports the runtime and adds tools, skills, channels, and commands. The same TypeScript, all the way down — nothing to bolt on."
              visual={<PluginCode />}
            />
          </Reveal>
          <Reveal>
            <FeatureRow
              eyebrow="One folder, one container"
              title="A whole agent you can hold in your head."
              blurb="It lives in a single folder and runs in its own container — its own .env, its own memory, its own channels. The container is the trust boundary; nothing it does reaches the rest of your machine. Done with it? Delete the folder. It's gone, no residue."
              reverse
              visual={<SandboxDiagram />}
            />
          </Reveal>
          <Reveal>
            <FeatureRow
              eyebrow="You hold the keys"
              title="A stranger in Slack can't push to main. You can."
              blurb="Owner, trusted, member, guest — role-based permissions gate every action, per channel. The agent knows who's in the room and exactly what they're allowed to ask for. Powerful in your hands, harmless in everyone else's."
              visual={<PermissionsVisual />}
            />
          </Reveal>
        </section>

        <section className="mx-auto max-w-3xl px-5 pb-24 sm:px-6 sm:pb-36">
          <Reveal className="mb-10 text-center">
            <p className="font-mono text-xs tracking-[0.2em] text-brand-700 uppercase dark:text-brand-300">
              one minute, end to end
            </p>
            <h2 className="mt-3 text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
              Three commands in. It&apos;s already learning.
            </h2>
          </Reveal>
          <Reveal delay={120}>
            <AnimatedTerminal variant="glow" />
          </Reveal>
        </section>

        <section className="mx-auto max-w-6xl px-5 pb-24 sm:px-6 sm:pb-36">
          <Reveal className="mb-10 text-center">
            <p className="font-mono text-xs tracking-[0.2em] text-brand-700 uppercase dark:text-brand-300">Use cases</p>
            <h2 className="mt-3 text-balance text-4xl font-semibold tracking-tight sm:text-5xl">For every workflow</h2>
          </Reveal>
          <Reveal delay={120}>
            <UseCaseTabs />
          </Reveal>
        </section>

        <section className="mx-auto max-w-6xl px-5 pb-24 sm:px-6 sm:pb-36">
          <Reveal>
            <LiveProof />
          </Reveal>
        </section>

        <section className="mx-auto max-w-6xl px-5 pb-24 sm:px-6 sm:pb-36">
          <Reveal className="mb-10 text-center">
            <p className="font-mono text-xs tracking-[0.2em] text-brand-700 uppercase dark:text-brand-300">
              how it compares
            </p>
            <h2 className="mt-3 text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
              Where TypeClaw is the right choice.
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-base text-zinc-600 dark:text-zinc-400">
              These are all good — genuinely. Reach for OpenClaw when you want the biggest ecosystem, Hermes when Python
              is your stack. Reach for TypeClaw when you want a runtime you can read end to end, extend with an import,
              and keep as your own.
            </p>
          </Reveal>
          <Reveal delay={120}>
            <MarketingTable />
          </Reveal>
          <Reveal delay={180}>
            <p className="mx-auto mt-8 max-w-2xl text-center text-sm leading-relaxed text-zinc-500 dark:text-zinc-500">
              These are all capable runtimes. OpenClaw is the broad platform; Hermes is the mature Python agent.
              TypeClaw&apos;s edge is the combination: one readable TypeScript codebase you own — memory you can diff in
              its own git repo, isolated per agent, and extended with a plain import.
            </p>
          </Reveal>
        </section>

        <section className="relative overflow-hidden border-y border-brand-100 bg-gradient-to-br from-brand-50 via-white to-brand-50 py-32 dark:border-brand-900/40 dark:from-brand-950/40 dark:via-zinc-950 dark:to-brand-950/40">
          <div
            aria-hidden
            className="absolute inset-0 opacity-40 dark:opacity-20"
            style={{
              backgroundImage: 'radial-gradient(circle at center, rgba(54, 72, 132, 0.15) 1px, transparent 1px)',
              backgroundSize: '24px 24px',
            }}
          />
          <Reveal className="relative mx-auto max-w-3xl px-5 text-center sm:px-6">
            <Image src="/typeey-cutout.png" alt="" width={120} height={120} aria-hidden className="mx-auto" />
            <h2 className="mt-4 text-balance text-5xl font-semibold tracking-tight sm:text-6xl">Make it yours.</h2>
            <p className="mx-auto mt-4 max-w-lg text-balance text-base text-zinc-600 dark:text-zinc-400">
              One folder, one container, one language you already know. Spin one up, read the whole thing, fork it if
              you like. Trying it costs nothing.
            </p>
            <div className="mt-8 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
              <Link
                href="/docs/guides/quickstart"
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-brand-700 px-6 py-3 text-sm font-medium text-white shadow-sm transition-all hover:translate-y-[-1px] hover:bg-brand-800 hover:shadow-md dark:bg-brand-600 dark:hover:bg-brand-500"
              >
                <BookOpen className="size-4" strokeWidth={2.4} aria-hidden />
                Start in 5 minutes
              </Link>
              <a
                href="https://github.com/typeclaw/typeclaw"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-300 bg-white px-6 py-3 text-sm font-medium text-zinc-800 transition-all hover:border-zinc-400 hover:shadow-sm dark:border-white/[0.12] dark:bg-white/[0.02] dark:text-zinc-200 dark:hover:border-white/[0.2]"
              >
                <Github className="size-4" strokeWidth={2.4} aria-hidden />
                Star on GitHub
              </a>
            </div>
          </Reveal>
        </section>
      </main>

      <footer className="border-t border-zinc-100 bg-white dark:border-white/[0.04] dark:bg-zinc-950">
        <div className="mx-auto grid max-w-6xl grid-cols-1 gap-10 px-5 py-14 sm:grid-cols-2 sm:px-6 sm:py-16 lg:grid-cols-5">
          <div className="col-span-2">
            <div className="flex items-center gap-2">
              <Image src="/typeclaw.png" alt="TypeClaw" width={24} height={24} className="rounded-md" />
              <span className="text-sm font-semibold tracking-tight">TypeClaw</span>
            </div>
            <p className="mt-3 max-w-xs text-sm leading-relaxed text-zinc-500 dark:text-zinc-500">
              Crafted in every detail — it behaves in your team&apos;s chat and gets sharper the longer it runs.
            </p>
            <p className="mt-6 text-xs text-zinc-400 dark:text-zinc-600">© {new Date().getFullYear()} TypeClaw · MIT</p>
          </div>
          <div>
            <p className="text-xs font-medium tracking-wider text-zinc-400 uppercase dark:text-zinc-500">Product</p>
            <ul className="mt-3 space-y-2 text-sm">
              <li>
                <Link
                  href="/"
                  className="text-zinc-600 hover:text-brand-700 dark:text-zinc-400 dark:hover:text-brand-300"
                >
                  Overview
                </Link>
              </li>
              <li>
                <a
                  href="https://www.npmjs.com/package/typeclaw"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-zinc-600 hover:text-brand-700 dark:text-zinc-400 dark:hover:text-brand-300"
                >
                  npm
                </a>
              </li>
            </ul>
          </div>
          <div>
            <p className="text-xs font-medium tracking-wider text-zinc-400 uppercase dark:text-zinc-500">Docs</p>
            <ul className="mt-3 space-y-2 text-sm">
              <li>
                <Link
                  href="/docs/guides/quickstart"
                  className="text-zinc-600 hover:text-brand-700 dark:text-zinc-400 dark:hover:text-brand-300"
                >
                  Quickstart
                </Link>
              </li>
              <li>
                <Link
                  href="/docs/guides/write-a-plugin"
                  className="text-zinc-600 hover:text-brand-700 dark:text-zinc-400 dark:hover:text-brand-300"
                >
                  Write a plugin
                </Link>
              </li>
              <li>
                <Link
                  href="/docs/concepts/architecture"
                  className="text-zinc-600 hover:text-brand-700 dark:text-zinc-400 dark:hover:text-brand-300"
                >
                  Architecture
                </Link>
              </li>
              <li>
                <Link
                  href="/docs/reference/typeclaw-json"
                  className="text-zinc-600 hover:text-brand-700 dark:text-zinc-400 dark:hover:text-brand-300"
                >
                  Configuration
                </Link>
              </li>
            </ul>
          </div>
          <div>
            <p className="text-xs font-medium tracking-wider text-zinc-400 uppercase dark:text-zinc-500">Community</p>
            <ul className="mt-3 space-y-2 text-sm">
              <li>
                <a
                  href="https://github.com/typeclaw/typeclaw"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-zinc-600 hover:text-brand-700 dark:text-zinc-400 dark:hover:text-brand-300"
                >
                  GitHub
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/typeclaw/typeclaw/discussions"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-zinc-600 hover:text-brand-700 dark:text-zinc-400 dark:hover:text-brand-300"
                >
                  Discussions
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/typeclaw/typeclaw/blob/main/LICENSE"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-zinc-600 hover:text-brand-700 dark:text-zinc-400 dark:hover:text-brand-300"
                >
                  MIT License
                </a>
              </li>
            </ul>
          </div>
        </div>
      </footer>
    </div>
  )
}
