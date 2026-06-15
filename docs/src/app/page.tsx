import { highlight } from 'fumadocs-core/highlight'
import {
  ArrowRight,
  BookOpen,
  Bot,
  Check,
  CheckCheck,
  CircleDashed,
  EyeOff,
  FileText,
  Github,
  KeyRound,
  Layers,
  Lock,
  Minus,
  Network,
  RefreshCw,
  Search,
  Shield,
  Sparkles,
  Star,
  Terminal,
  User,
  Waves,
  X,
  Zap,
} from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'
import { Fragment } from 'react'

import { AnimatedTerminal } from './_components/animated-terminal'
import { CHANNELS } from './_components/channel-icons'
import { CopyButton } from './_components/copy-button'
import { COMPARISON_FEATURES, COMPETITORS, INSTALL_COMMAND, VERSION } from './_components/data'
import { FEATURE_CATEGORIES } from './_components/features-data'
import { HeroSpotlight } from './_components/hero-spotlight'
import { Reveal } from './_components/reveal'
import { ThemeToggle } from './_components/theme-toggle'
import { UseCaseTabs } from './_components/use-case-tabs'

const SELF_EXTEND_CODE = `import { definePlugin } from 'typeclaw/plugin'

export default definePlugin({
  plugin: () => ({
    tools: {
      postReview: {
        description: 'Post a PR review to GitHub',
        async execute({ url, body }) {
          /* … */
        },
      },
    },
  }),
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

function GroupChatVisual() {
  return (
    <div className="relative w-full overflow-hidden rounded-2xl border border-zinc-200 bg-gradient-to-br from-zinc-50 to-white p-5 sm:p-7 dark:border-white/[0.08] dark:from-white/[0.03] dark:to-zinc-950">
      <div className="flex flex-col gap-3.5">
        <div className="flex items-start gap-2.5">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-zinc-500 dark:bg-white/[0.08] dark:text-zinc-400">
            <User className="size-3.5" strokeWidth={2.2} aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="font-mono text-[11px] text-zinc-400 dark:text-zinc-600">alex</p>
            <div className="mt-1 rounded-2xl rounded-tl-sm border border-zinc-200 bg-white px-3.5 py-2 text-sm text-zinc-700 dark:border-white/[0.08] dark:bg-zinc-900 dark:text-zinc-300">
              @jordan can you take the deploy?
            </div>
            <p className="mt-1.5 inline-flex items-center gap-1.5 font-mono text-[11px] text-zinc-400 dark:text-zinc-600">
              <EyeOff className="size-3" strokeWidth={2.2} aria-hidden />
              observing — not addressed to me
            </p>
          </div>
        </div>

        <div className="flex items-start gap-2.5">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-zinc-500 dark:bg-white/[0.08] dark:text-zinc-400">
            <Bot className="size-3.5" strokeWidth={2.2} aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="inline-flex items-center gap-1.5 font-mono text-[11px] text-zinc-400 dark:text-zinc-600">
              ci-bot
              <span className="rounded bg-zinc-200 px-1 text-[9px] tracking-wider text-zinc-500 uppercase dark:bg-white/[0.08] dark:text-zinc-400">
                bot
              </span>
            </p>
            <div className="mt-1 rounded-2xl rounded-tl-sm border border-zinc-200 bg-white px-3.5 py-2 text-sm text-zinc-500 dark:border-white/[0.08] dark:bg-zinc-900 dark:text-zinc-500">
              build passed
            </div>
          </div>
        </div>

        <div className="flex items-start gap-2.5">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-zinc-500 dark:bg-white/[0.08] dark:text-zinc-400">
            <User className="size-3.5" strokeWidth={2.2} aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="font-mono text-[11px] text-zinc-400 dark:text-zinc-600">sam</p>
            <div className="mt-1 rounded-2xl rounded-tl-sm border border-zinc-200 bg-white px-3.5 py-2 text-sm text-zinc-700 dark:border-white/[0.08] dark:bg-zinc-900 dark:text-zinc-300">
              <span className="font-medium text-brand-700 dark:text-brand-300">@typeey</span> draft the changelog?
            </div>
          </div>
        </div>

        <div className="flex items-start gap-2.5">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-600 text-white dark:bg-brand-500">
            <Sparkles className="size-3.5" strokeWidth={2.4} aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="font-mono text-[11px] text-brand-600 dark:text-brand-300">typeey</p>
            <div className="mt-1 rounded-2xl rounded-tl-sm border border-brand-200 bg-brand-50 px-3.5 py-2 text-sm text-brand-900 shadow-sm dark:border-brand-800/60 dark:bg-brand-950/50 dark:text-brand-100">
              On it — drafting the changelog now.
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function SubagentVisual() {
  const children = [
    { label: 'research', icon: Search },
    { label: 'review', icon: CheckCheck },
    { label: 'execute', icon: Terminal },
  ]
  return (
    <div className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl border border-zinc-200 bg-gradient-to-br from-zinc-50 to-white p-5 sm:p-8 dark:border-white/[0.08] dark:from-white/[0.03] dark:to-zinc-950">
      <div className="flex h-full flex-col items-center justify-center">
        <div className="inline-flex items-center gap-2 rounded-xl border border-brand-200 bg-white px-4 py-2.5 shadow-sm dark:border-brand-800/60 dark:bg-zinc-900">
          <Network className="size-4 text-brand-600 dark:text-brand-300" strokeWidth={2.4} aria-hidden />
          <span className="text-sm font-medium text-zinc-800 dark:text-zinc-100">main session</span>
        </div>
        <div
          aria-hidden
          className="h-6 w-px bg-gradient-to-b from-brand-300 to-brand-200 dark:from-brand-700 dark:to-brand-800/50"
        />
        <div
          aria-hidden
          className="h-px w-3/4 bg-gradient-to-r from-transparent via-brand-200 to-transparent dark:via-brand-800/60"
        />
        <div className="mt-5 grid w-full grid-cols-3 gap-2.5 sm:gap-3">
          {children.map(({ label, icon: Icon }) => (
            <div
              key={label}
              className="flex flex-col items-center gap-2 rounded-xl border border-zinc-200 bg-white px-2 py-3 text-center shadow-sm dark:border-white/[0.08] dark:bg-zinc-900"
            >
              <span className="inline-flex size-8 items-center justify-center rounded-lg bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300">
                <Icon className="size-4" strokeWidth={2.2} aria-hidden />
              </span>
              <span className="font-mono text-xs font-medium text-zinc-700 dark:text-zinc-300">{label}</span>
              <span className="text-[10px] leading-tight text-zinc-400 dark:text-zinc-600">own context</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function SecurityVisual() {
  const layers = [
    { icon: Shield, label: 'Guards', detail: 'severity-classified policies' },
    { icon: KeyRound, label: 'Roles', detail: 'who can bypass what' },
    { icon: Lock, label: 'Sandbox', detail: 'each bash call isolated' },
  ]
  return (
    <div className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl border border-zinc-200 bg-gradient-to-br from-zinc-50 to-white p-5 sm:p-8 dark:border-white/[0.08] dark:from-white/[0.03] dark:to-zinc-950">
      <div className="flex h-full flex-col justify-center gap-2.5">
        <div className="mx-auto inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-3 py-1 font-mono text-[11px] text-zinc-500 shadow-sm dark:border-white/[0.08] dark:bg-zinc-900 dark:text-zinc-400">
          tool call
        </div>
        {layers.map(({ icon: Icon, label, detail }) => (
          <div key={label} className="flex flex-col items-center gap-2.5">
            <ArrowRight
              className="size-3.5 rotate-90 text-brand-300 dark:text-brand-700"
              strokeWidth={2.4}
              aria-hidden
            />
            <div className="flex w-full items-center gap-3 rounded-xl border border-brand-200 bg-white px-4 py-2.5 shadow-sm dark:border-brand-800/60 dark:bg-zinc-900">
              <Icon className="size-4 shrink-0 text-brand-600 dark:text-brand-300" strokeWidth={2.4} aria-hidden />
              <div className="min-w-0">
                <span className="text-sm font-medium text-zinc-800 dark:text-zinc-100">{label}</span>
                <span className="ml-2 text-xs text-zinc-400 dark:text-zinc-600">{detail}</span>
              </div>
            </div>
          </div>
        ))}
        <ArrowRight
          className="mx-auto size-3.5 rotate-90 text-brand-300 dark:text-brand-700"
          strokeWidth={2.4}
          aria-hidden
        />
        <div className="mx-auto inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 font-mono text-[11px] font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
          <Check className="size-3.5" strokeWidth={2.6} aria-hidden />
          fires, contained
        </div>
      </div>
    </div>
  )
}

function SelfManagingVisual() {
  const fields = [
    { line: '"models": { … }', state: 'live' as const },
    { line: '"channels": { … }', state: 'live' as const },
    { line: '"alias": { … }', state: 'live' as const },
    { line: '"sandbox": "proc-bind"', state: 'restart' as const },
    { line: '"port": 8973', state: 'restart' as const },
  ]
  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-lg dark:border-white/[0.08] dark:bg-zinc-950">
      <div className="flex items-center justify-between border-b border-zinc-100 bg-zinc-50 px-4 py-2.5 dark:border-white/[0.04] dark:bg-white/[0.02]">
        <div className="flex items-center gap-2">
          <FileText className="size-3.5 text-brand-600 dark:text-brand-300" strokeWidth={2.2} aria-hidden />
          <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">typeclaw.json</span>
        </div>
        <div className="flex items-center gap-2 font-mono text-[10px] tracking-wider uppercase">
          <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
            <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
            live
          </span>
          <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
            <span className="size-1.5 rounded-full bg-amber-500" aria-hidden />
            restart
          </span>
        </div>
      </div>
      <div className="divide-y divide-zinc-100 font-mono text-xs sm:text-[13px] dark:divide-white/[0.04]">
        {fields.map(({ line, state }) => (
          <div key={line} className="flex items-center justify-between gap-3 px-4 py-2.5 sm:px-5">
            <span className="truncate text-zinc-700 dark:text-zinc-300">{line}</span>
            {state === 'live' ? (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium tracking-wider text-emerald-700 uppercase dark:bg-emerald-900/30 dark:text-emerald-300">
                live
              </span>
            ) : (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium tracking-wider text-amber-700 uppercase dark:bg-amber-900/30 dark:text-amber-300">
                restart
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

async function SelfExtendVisual() {
  const highlighted = await highlight(SELF_EXTEND_CODE, {
    lang: 'typescript',
    themes: { light: 'github-light', dark: 'github-dark' },
    defaultColor: false,
    components: {
      pre: ({ children, ...props }) => (
        <pre
          {...props}
          className="mem-code overflow-x-auto p-4 font-mono text-xs leading-relaxed sm:p-5 sm:text-[13px]"
        >
          {children}
        </pre>
      ),
    },
  })
  return (
    <div className="relative w-full overflow-hidden rounded-2xl border border-zinc-200 bg-gradient-to-br from-zinc-50 to-white p-5 sm:p-7 dark:border-white/[0.08] dark:from-white/[0.03] dark:to-zinc-950">
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center gap-3 rounded-xl border border-dashed border-zinc-300 bg-zinc-50 px-4 py-3 dark:border-white/[0.12] dark:bg-white/[0.02]">
          <CircleDashed className="size-4 shrink-0 text-zinc-400 dark:text-zinc-600" strokeWidth={2.2} aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[11px] tracking-wider text-zinc-400 uppercase dark:text-zinc-600">needs</p>
            <p className="truncate text-sm text-zinc-600 dark:text-zinc-400">post PR reviews to GitHub</p>
          </div>
          <span className="shrink-0 rounded-full border border-zinc-200 bg-white px-2 py-0.5 font-mono text-[10px] tracking-wider text-zinc-400 uppercase dark:border-white/[0.08] dark:bg-zinc-900 dark:text-zinc-600">
            no tool yet
          </span>
        </div>

        <ArrowRight
          className="mx-auto size-3.5 rotate-90 text-brand-300 dark:text-brand-700"
          strokeWidth={2.4}
          aria-hidden
        />

        <div className="overflow-hidden rounded-xl border border-brand-200 bg-white shadow-sm dark:border-brand-800/60 dark:bg-zinc-950">
          <div className="flex items-center justify-between gap-2 border-b border-zinc-100 bg-zinc-50 px-3.5 py-2 dark:border-white/[0.04] dark:bg-white/[0.02]">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-2 py-0.5 font-mono text-[10px] font-medium text-brand-700 dark:bg-brand-950/60 dark:text-brand-300">
              <Sparkles className="size-3" strokeWidth={2.4} aria-hidden />
              written by my-agent
            </span>
            <span className="truncate font-mono text-[11px] text-zinc-400 dark:text-zinc-600">
              plugins/pr-review.ts
            </span>
          </div>
          {highlighted}
        </div>

        <ArrowRight
          className="mx-auto size-3.5 rotate-90 text-brand-300 dark:text-brand-700"
          strokeWidth={2.4}
          aria-hidden
        />

        <div className="flex items-center gap-3 rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 shadow-sm dark:border-brand-800/60 dark:bg-brand-950/50">
          <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-white dark:bg-brand-500">
            <Check className="size-4" strokeWidth={2.6} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-mono text-sm font-medium text-brand-900 dark:text-brand-100">postReview</p>
            <p className="text-[11px] text-brand-700/70 dark:text-brand-300/70">now in its toolset</p>
          </div>
          <span className="shrink-0 rounded-full bg-brand-600 px-2 py-0.5 font-mono text-[10px] font-medium tracking-wider text-white uppercase dark:bg-brand-500">
            ready
          </span>
        </div>
      </div>
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

const MEMORY_TIERS = [
  {
    icon: Waves,
    kind: 'Short-term',
    label: 'Streams',
    path: 'memory/streams/',
    blurb: 'Every reply and tool call lands in a daily log as it happens — the raw record of what it just did.',
  },
  {
    icon: Layers,
    kind: 'Long-term',
    label: 'Topics',
    path: 'memory/topics/',
    blurb:
      'The dreaming subagent distills those days into sharded knowledge, one subject per file, that it can recall later.',
  },
  {
    icon: Zap,
    kind: 'Muscle memory',
    label: 'Skills',
    path: 'memory/skills/',
    blurb:
      'Recurring procedures get written into reusable skills it loads automatically — things it can do without thinking them through again.',
    peak: true,
  },
]

function MemoryTiers() {
  return (
    <div className="mem-loop">
      <div className="grid grid-cols-1 items-stretch gap-3 sm:grid-cols-[1fr_auto_1fr_auto_1fr]">
        {MEMORY_TIERS.map(({ icon: Icon, kind, label, path, blurb, peak }, i) => (
          <Fragment key={label}>
            {i > 0 && (
              <div aria-hidden className="flex items-center justify-center py-1 sm:py-0">
                <ArrowRight
                  className="mem-flow size-5 rotate-90 text-brand-400 sm:rotate-0 dark:text-brand-500"
                  strokeWidth={2.4}
                  style={{ '--mem-i': i - 1 } as React.CSSProperties}
                />
              </div>
            )}
            <div
              style={{ '--mem-i': i } as React.CSSProperties}
              className={`mem-tier relative flex flex-col rounded-2xl border p-5 shadow-sm ${
                peak
                  ? 'border-brand-300 bg-gradient-to-br from-brand-50 to-white dark:border-brand-700/70 dark:from-brand-950/60 dark:to-zinc-950'
                  : 'border-zinc-200 bg-white dark:border-white/[0.08] dark:bg-white/[0.02]'
              }`}
            >
              <div className="flex items-center justify-between">
                <span
                  className={`inline-flex size-10 items-center justify-center rounded-xl ${
                    peak
                      ? 'bg-brand-600 text-white dark:bg-brand-500'
                      : 'bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300'
                  }`}
                >
                  <Icon className="size-5" strokeWidth={2.2} aria-hidden />
                </span>
                <span className="font-mono text-[11px] text-zinc-400 dark:text-zinc-600" aria-hidden>
                  0{i + 1}
                </span>
              </div>
              <p className="mt-4 font-mono text-[11px] tracking-[0.14em] text-brand-700 uppercase dark:text-brand-300">
                {kind}
              </p>
              <p className="mt-1 text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">{label}</p>
              <code className="mt-1 font-mono text-[11px] text-zinc-400 dark:text-zinc-600">{path}</code>
              <p className="mt-3 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">{blurb}</p>
            </div>
          </Fragment>
        ))}
      </div>
      <div className="mt-5 flex items-center gap-3 text-xs text-zinc-500 dark:text-zinc-500">
        <span aria-hidden className="h-px flex-1 bg-gradient-to-r from-transparent to-brand-200 dark:to-brand-800/60" />
        <span className="mem-loopback inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-3 py-1 font-medium text-brand-700 dark:bg-brand-950/60 dark:text-brand-300">
          <RefreshCw className="size-3.5" strokeWidth={2.4} aria-hidden />
          what it learns loops back into the next session
        </span>
        <span aria-hidden className="h-px flex-1 bg-gradient-to-l from-transparent to-brand-200 dark:to-brand-800/60" />
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
                <p
                  className={`mx-auto mt-3 max-w-[12rem] text-[13px] font-semibold leading-snug tracking-normal normal-case ${
                    r.highlight ? 'text-brand-700 dark:text-brand-300' : 'text-zinc-700 dark:text-zinc-200'
                  }`}
                >
                  {r.strength}
                </p>
                <p className="mx-auto mt-1.5 max-w-[12rem] text-[11px] font-normal leading-relaxed tracking-normal text-zinc-400 normal-case dark:text-zinc-500">
                  {r.tradeoff}
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
              It gets sharper while you sleep — building muscle memory you can read.
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-zinc-600 dark:text-zinc-400">
              A dreaming subagent distills each day&apos;s work into long-term memory, and the moves it makes often
              become muscle memory — reusable skills it writes for itself and loads on later runs. It all lands as plain
              files, committed to git, so you can review what it picked up, revert what it got wrong, and own its memory
              like the rest of your code. Plain files you can read, not a black box.
            </p>
          </Reveal>
          <Reveal className="mt-14" delay={120}>
            <MemoryTiers />
          </Reveal>
        </section>

        <section className="mx-auto max-w-6xl space-y-24 px-5 py-24 sm:space-y-36 sm:px-6 sm:py-36">
          <Reveal>
            <FeatureRow
              eyebrow="Knows when not to talk"
              title="It reads the room — and stays quiet when the message wasn't for it."
              blurb="In a busy channel it tells humans from bots, tracks who's present, and engages on a structural decision rather than a guess. When a message clearly targets someone else, it holds back; mid-thread with you, it stays engaged without being re-mentioned, then steps back when the conversation moves on. Peer-bot loop guards and flood filters keep it from spiraling."
              visual={<GroupChatVisual />}
            />
          </Reveal>
          <Reveal>
            <FeatureRow
              eyebrow="A bench of specialists"
              title="It delegates to focused specialists, each in a clean context."
              blurb="It hands off research, planning, review, and hands-on execution to child sessions — each with its own system prompt, tools, and model. Spawn and wait for a result, or fan work out in the background and collect completions later. Coalescing drops duplicate concurrent runs and depth limits keep delegation chains bounded."
              reverse
              visual={<SubagentVisual />}
            />
          </Reveal>
          <Reveal>
            <FeatureRow
              eyebrow="Defense in depth"
              title="Every tool call runs a gauntlet before it fires."
              blurb="Risky actions pass through layered guards classified by severity — secret exfiltration, SSRF, prompt injection, rogue git pushes, and silent privilege escalation get stopped before they happen. Roles gate who can bypass what, and each bash call runs inside its own sandbox. Powerful in trusted hands, contained everywhere else."
              visual={<SecurityVisual />}
            />
          </Reveal>
          <Reveal>
            <FeatureRow
              eyebrow="Operational autonomy"
              title="It knows its own config — so it won't strand itself."
              blurb="It can back itself up, rebuild, and restart its own container through the host daemon. The difference: it knows which settings take effect live and which need a restart, so it won't brick itself with a change that silently does nothing. When it does restart, it hands off to the rebooted container and picks the same conversation back up — no cold-starting into silence. And when it keeps working on its own, hard budgets on turns, tokens, and wall-clock keep it from spiraling."
              reverse
              visual={<SelfManagingVisual />}
            />
          </Reveal>
          <Reveal>
            <FeatureRow
              eyebrow="Plugin system"
              title="It writes its own tools — as TypeScript plugins."
              blurb="When a recurring job needs more than it ships with — a custom tool, a scheduled hook, a new channel — it writes itself a plugin to do it. A plugin is just a TypeScript file that imports the runtime: no DSL, no IPC, no sidecar. The same language it already runs in, so the harness it builds for itself is code you can read and keep."
              visual={<SelfExtendVisual />}
            />
          </Reveal>
        </section>

        <section className="mx-auto max-w-3xl px-5 pb-24 sm:px-6 sm:pb-36">
          <Reveal className="mb-10 text-center">
            <p className="font-mono text-xs tracking-[0.2em] text-brand-700 uppercase dark:text-brand-300">
              one command to hatch
            </p>
            <h2 className="mt-3 text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
              One <code className="font-mono text-3xl sm:text-4xl">init</code> — wired, hatched, already learning.
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
            <p className="font-mono text-xs tracking-[0.2em] text-brand-700 uppercase dark:text-brand-300">
              built for people like you
            </p>
            <h2 className="mt-3 text-balance text-5xl font-semibold tracking-tight sm:text-6xl">
              Made with care. Now make it yours.
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-balance text-base leading-relaxed text-zinc-600 dark:text-zinc-400">
              Every detail here was sweated over — because the details are the point. One folder, one container, one
              language you already know. Spin one up, read it end to end, and shape it until it&apos;s exactly the agent
              you wanted. Trying it costs nothing.
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
          <div className="lg:col-span-2">
            <div className="flex items-center gap-2">
              <Image src="/typeclaw.png" alt="TypeClaw" width={24} height={24} className="rounded-md" />
              <span className="text-sm font-semibold tracking-tight">TypeClaw</span>
            </div>
            <p className="mt-3 max-w-xs text-sm leading-relaxed text-zinc-500 dark:text-zinc-500">
              Crafted in every detail — it behaves in your team&apos;s chat and gets sharper the longer it runs.
            </p>
            <p className="mt-6 text-xs text-zinc-400 dark:text-zinc-600">
              © {new Date().getFullYear()} TypeClaw · Made with{' '}
              <span className="text-rose-500 dark:text-rose-400">❤</span> from Seoul
            </p>
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
