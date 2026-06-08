import {
  ArrowRight,
  BookOpen,
  Check,
  Container,
  Github,
  Lock,
  PenTool,
  Quote,
  Shield,
  Sparkles,
  Star,
  User,
  Users,
  X,
} from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'

import { AnimatedTerminal } from './_components/animated-terminal'
import { CHANNELS } from './_components/channel-icons'
import { CopyButton } from './_components/copy-button'
import { COMPETITORS, INSTALL_COMMAND, MEMORY_LOOP, VERSION } from './_components/data'
import { ThemeToggle } from './_components/theme-toggle'
import { UseCaseTabs } from './_components/use-case-tabs'

const PLUGIN_CODE = `import { definePlugin } from 'typeclaw'

export default definePlugin({
  name: 'pr-review',
  tools: {
    triage: async ({ pr }) => {
      const diff = await gh.getDiff(pr)
      return summarize(diff)
    },
  },
  skills: ['skills/pr-review.md'],
})`

function HeroInstall() {
  return (
    <div className="group relative mx-auto w-full max-w-xl">
      <div
        aria-hidden
        className="absolute -inset-px rounded-2xl bg-gradient-to-r from-brand-400/30 via-brand-200/40 to-brand-400/30 opacity-70 blur-md transition-opacity group-hover:opacity-100 dark:from-brand-700/40 dark:via-brand-500/30 dark:to-brand-700/40"
      />
      <div className="relative flex items-center justify-between gap-2 rounded-2xl border border-zinc-200 bg-white py-3 pr-2 pl-5 font-mono text-sm text-zinc-800 shadow-lg dark:border-white/[0.1] dark:bg-zinc-950 dark:text-zinc-100">
        <span className="text-zinc-400 dark:text-zinc-600" aria-hidden>
          $
        </span>
        <span className="flex-1 truncate">{INSTALL_COMMAND}</span>
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
    <div className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl border border-zinc-200 bg-gradient-to-br from-zinc-50 to-white p-8 dark:border-white/[0.08] dark:from-white/[0.03] dark:to-zinc-950">
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
      <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-relaxed text-zinc-700 dark:text-zinc-300">
        <code>{PLUGIN_CODE}</code>
      </pre>
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
      <div className="inline-flex size-7 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
        <span className="font-mono text-xs">~</span>
      </div>
    )
  }
  return value ? (
    <div className="inline-flex size-7 items-center justify-center rounded-full bg-brand-100 text-brand-700 dark:bg-brand-900/50 dark:text-brand-300">
      <Check className="size-4" strokeWidth={2.5} aria-hidden />
    </div>
  ) : (
    <div className="inline-flex size-7 items-center justify-center rounded-full bg-zinc-100 text-zinc-400 dark:bg-white/[0.04] dark:text-zinc-600">
      <X className="size-4" strokeWidth={2.5} aria-hidden />
    </div>
  )
}

function MarketingTable() {
  return (
    <div className="-mx-2 overflow-x-auto sm:mx-0">
      <table className="w-full min-w-[940px] text-left text-sm">
        <thead>
          <tr className="border-b border-zinc-200 text-xs tracking-wider text-zinc-500 uppercase dark:border-white/[0.06] dark:text-zinc-500">
            <th className="px-4 py-4 font-medium">Runtime</th>
            <th className="px-4 py-4 text-center font-medium">Docker-first</th>
            <th className="px-4 py-4 text-center font-medium">Self-improving</th>
            <th className="px-4 py-4 text-center font-medium">Multi-channel</th>
            <th className="px-4 py-4 text-center font-medium">Full-featured plugins</th>
            <th className="px-4 py-4 text-center font-medium">Git-native</th>
            <th className="px-4 py-4 text-center font-medium">Permission system</th>
            <th className="px-4 py-4 font-medium">Notes</th>
          </tr>
        </thead>
        <tbody>
          {COMPETITORS.map((r) => (
            <tr
              key={r.name}
              className={
                r.highlight
                  ? 'border-b border-brand-200/60 bg-brand-50/70 dark:border-brand-800/40 dark:bg-brand-950/30'
                  : 'border-b border-zinc-100 dark:border-white/[0.04]'
              }
            >
              <td className="px-4 py-5">
                <div
                  className={
                    r.highlight
                      ? 'font-semibold text-brand-800 dark:text-brand-100'
                      : 'font-medium text-zinc-800 dark:text-zinc-200'
                  }
                >
                  {r.name}
                </div>
                <div className="mt-0.5 font-mono text-[11px] text-zinc-500 dark:text-zinc-500">{r.lang}</div>
              </td>
              <td className="px-4 py-5 text-center">
                <CheckCell value={r.dockerFirst} />
              </td>
              <td className="px-4 py-5 text-center">
                <CheckCell value={r.selfImproving} />
              </td>
              <td className="px-4 py-5 text-center">
                <CheckCell value={r.multiChannel} />
              </td>
              <td className="px-4 py-5 text-center">
                <CheckCell value={r.fullFeaturedPlugins} />
              </td>
              <td className="px-4 py-5 text-center">
                <CheckCell value={r.gitNative} />
              </td>
              <td className="px-4 py-5 text-center">
                <CheckCell value={r.permissionSystem} />
              </td>
              <td className="px-4 py-5 text-zinc-600 dark:text-zinc-400">
                <span className="font-medium text-zinc-700 dark:text-zinc-300">{r.strength}</span>
                <span className="text-zinc-400 dark:text-zinc-600"> · {r.tradeoff}</span>
              </td>
            </tr>
          ))}
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
      <div className={reverse ? 'lg:order-2' : ''}>
        <p className="font-mono text-xs tracking-[0.2em] text-brand-700 uppercase dark:text-brand-300">{eyebrow}</p>
        <h3 className="mt-3 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h3>
        <p className="mt-4 max-w-md text-base leading-relaxed text-zinc-600 dark:text-zinc-400">{blurb}</p>
      </div>
      <div className={reverse ? 'lg:order-1' : ''}>{visual}</div>
    </div>
  )
}

function PermissionsVisual() {
  return (
    <div className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl border border-zinc-200 bg-gradient-to-br from-zinc-50 to-white p-8 dark:border-white/[0.08] dark:from-white/[0.03] dark:to-zinc-950">
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

function Testimonial() {
  return (
    <div className="mx-auto max-w-3xl">
      <div className="relative rounded-2xl border border-brand-100 bg-gradient-to-br from-brand-50/80 to-white p-10 dark:border-brand-900/40 dark:from-brand-950/40 dark:to-zinc-950">
        <Quote
          className="absolute top-6 left-6 size-8 text-brand-200 dark:text-brand-800"
          strokeWidth={2.4}
          aria-hidden
        />
        <blockquote className="relative pt-8 text-center">
          <p className="text-xl font-medium leading-relaxed text-zinc-800 dark:text-zinc-100 sm:text-2xl">
            &ldquo;Last week I told my agent I prefer kebab-case for filenames. Yesterday it suggested a rename without
            me asking.&rdquo;
          </p>
          <footer className="mt-6 text-sm text-zinc-500 dark:text-zinc-500">— A TypeClaw user</footer>
        </blockquote>
      </div>
    </div>
  )
}

export default function Home() {
  return (
    <div className="min-h-screen bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
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
          <div className="relative z-10 mx-auto max-w-4xl px-6 pt-24 pb-20 text-center sm:pt-32">
            <div className="inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white/60 px-3 py-1 text-xs font-medium text-zinc-600 backdrop-blur dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-zinc-400">
              <Sparkles className="size-3.5 text-brand-600 dark:text-brand-300" strokeWidth={2.4} aria-hidden />
              {VERSION} · TypeScript agent runtime
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
              <h1 className="text-balance text-5xl font-semibold tracking-tight sm:text-6xl lg:text-7xl">
                The agent that
                <br />
                <span className="bg-gradient-to-br from-brand-700 to-brand-500 bg-clip-text text-transparent dark:from-brand-200 dark:to-brand-400">
                  keeps its nest tidy.
                </span>
              </h1>
            </div>
            <p className="mx-auto mt-7 max-w-xl text-balance text-lg leading-relaxed text-zinc-600 dark:text-zinc-400">
              A TypeScript agent that lives in one folder, distills its own work into long-term memory, and gets sharper
              the longer it runs.
            </p>
            <div className="mt-10">
              <HeroInstall />
            </div>
            <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link
                href="/docs/guides/getting-started"
                className="inline-flex items-center gap-2 rounded-xl bg-brand-700 px-5 py-3 text-sm font-medium text-white shadow-sm transition-all hover:translate-y-[-1px] hover:bg-brand-800 hover:shadow-md dark:bg-brand-600 dark:hover:bg-brand-500"
              >
                Read the docs
                <ArrowRight className="size-4" strokeWidth={2.4} aria-hidden />
              </Link>
              <a
                href="https://github.com/typeclaw/typeclaw"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-xl border border-zinc-300 bg-white px-5 py-3 text-sm font-medium text-zinc-800 transition-all hover:border-zinc-400 hover:shadow-sm dark:border-white/[0.12] dark:bg-white/[0.02] dark:text-zinc-200 dark:hover:border-white/[0.2]"
              >
                <Star className="size-4" strokeWidth={2.4} aria-hidden />
                Star on GitHub
              </a>
            </div>
          </div>
        </section>

        <section className="border-y border-zinc-100 bg-zinc-50/50 py-12 dark:border-white/[0.04] dark:bg-white/[0.01]">
          <ChannelTrust />
        </section>

        <section className="mx-auto max-w-6xl px-6 py-28">
          <div className="text-center">
            <p className="font-mono text-xs tracking-[0.2em] text-brand-700 uppercase dark:text-brand-300">
              Self-improving
            </p>
            <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
              It remembers. It learns. It gets sharper while you sleep.
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-zinc-600 dark:text-zinc-400">
              Every conversation, every command, every insight — your agent watches its own work, then a dreaming
              subagent distills it into long-term memory and reusable skills. No prompts to write. It just gets better.
            </p>
          </div>
          <div className="mx-auto mt-12 max-w-lg">
            <div className="rounded-2xl border border-brand-100 bg-gradient-to-br from-brand-50/80 to-white p-8 dark:border-brand-900/40 dark:from-brand-950/40 dark:to-zinc-950">
              <MemoryLoopVertical />
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-6xl space-y-24 px-6 py-24">
          <FeatureRow
            eyebrow="Just a folder"
            title="One folder. One agent. No mess."
            blurb="Drop it in any folder. One command, and it's alive. Its own .env, its own memory, its own channels. When you're done, delete the folder — it's gone. No global install, no residue."
            visual={<SandboxDiagram />}
          />
          <FeatureRow
            eyebrow="Safe by design"
            title="You're in control. Always."
            blurb="Owner, trusted, member, guest — role-based permissions gate every action. A Slack stranger can't tell your agent to push to main. You can. The agent knows who's in the room and what they can do."
            reverse
            visual={<PermissionsVisual />}
          />
          <FeatureRow
            eyebrow="Plugins as imports"
            title="Teach it something new? Just write TypeScript."
            blurb="No IPC, no FFI, no weird config files. Plain .ts files that contribute tools, skills, channels, and commands — all in the language you already write."
            visual={<PluginCode />}
          />
        </section>

        <section className="mx-auto max-w-3xl px-6 pb-28">
          <div className="mb-10 text-center">
            <p className="font-mono text-xs tracking-[0.2em] text-brand-700 uppercase dark:text-brand-300">
              one minute, end to end
            </p>
            <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
              Four commands. It&apos;s live.
            </h2>
          </div>
          <AnimatedTerminal variant="glow" />
        </section>

        <section className="mx-auto max-w-6xl px-6 pb-28">
          <div className="mb-10 text-center">
            <p className="font-mono text-xs tracking-[0.2em] text-brand-700 uppercase dark:text-brand-300">Use cases</p>
            <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">For every workflow</h2>
          </div>
          <UseCaseTabs />
        </section>

        <section className="mx-auto max-w-6xl px-6 pb-28">
          <Testimonial />
        </section>

        <section className="mx-auto max-w-6xl px-6 pb-28">
          <div className="mb-10 text-center">
            <p className="font-mono text-xs tracking-[0.2em] text-brand-700 uppercase dark:text-brand-300">
              how it compares
            </p>
            <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
              There are great agents. None had the right shape.
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-base text-zinc-600 dark:text-zinc-400">
              If you live in TypeScript and want plugins that are just imports, here&apos;s the honest landscape.
            </p>
          </div>
          <MarketingTable />
        </section>

        <section className="relative overflow-hidden border-y border-brand-100 bg-gradient-to-br from-brand-50 via-white to-brand-50 py-24 dark:border-brand-900/40 dark:from-brand-950/40 dark:via-zinc-950 dark:to-brand-950/40">
          <div
            aria-hidden
            className="absolute inset-0 opacity-40 dark:opacity-20"
            style={{
              backgroundImage: 'radial-gradient(circle at center, rgba(54, 72, 132, 0.15) 1px, transparent 1px)',
              backgroundSize: '24px 24px',
            }}
          />
          <div className="relative mx-auto max-w-3xl px-6 text-center">
            <Image src="/typeey-cutout.png" alt="" width={120} height={120} aria-hidden className="mx-auto" />
            <h2 className="mt-4 text-balance text-4xl font-semibold tracking-tight sm:text-5xl">Ready to try it?</h2>
            <p className="mx-auto mt-4 max-w-lg text-balance text-base text-zinc-600 dark:text-zinc-400">
              One command, one folder, one container. Trying it costs nothing.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link
                href="/docs/guides/getting-started"
                className="inline-flex items-center gap-2 rounded-xl bg-brand-700 px-6 py-3 text-sm font-medium text-white shadow-sm transition-all hover:translate-y-[-1px] hover:bg-brand-800 hover:shadow-md dark:bg-brand-600 dark:hover:bg-brand-500"
              >
                <BookOpen className="size-4" strokeWidth={2.4} aria-hidden />
                Read the docs
              </Link>
              <a
                href="https://github.com/typeclaw/typeclaw"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-xl border border-zinc-300 bg-white px-6 py-3 text-sm font-medium text-zinc-800 transition-all hover:border-zinc-400 hover:shadow-sm dark:border-white/[0.12] dark:bg-white/[0.02] dark:text-zinc-200 dark:hover:border-white/[0.2]"
              >
                <Github className="size-4" strokeWidth={2.4} aria-hidden />
                Star on GitHub
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-zinc-100 bg-white dark:border-white/[0.04] dark:bg-zinc-950">
        <div className="mx-auto grid max-w-6xl grid-cols-2 gap-10 px-6 py-16 sm:grid-cols-5">
          <div className="col-span-2">
            <div className="flex items-center gap-2">
              <Image src="/typeclaw.png" alt="TypeClaw" width={24} height={24} className="rounded-md" />
              <span className="text-sm font-semibold tracking-tight">typeclaw</span>
            </div>
            <p className="mt-3 max-w-xs text-sm leading-relaxed text-zinc-500 dark:text-zinc-500">
              A TypeScript-native, Bun-powered, Docker-friendly general-purpose agent runtime.
            </p>
            <p className="mt-6 text-xs text-zinc-400 dark:text-zinc-600">© {new Date().getFullYear()} typeclaw · MIT</p>
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
                  href="/docs/guides/getting-started"
                  className="text-zinc-600 hover:text-brand-700 dark:text-zinc-400 dark:hover:text-brand-300"
                >
                  Getting started
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
                  Reference
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
