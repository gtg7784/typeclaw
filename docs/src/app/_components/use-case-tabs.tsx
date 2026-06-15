'use client'

import {
  Clock,
  FileText,
  GitPullRequest,
  Github,
  Globe,
  type LucideIcon,
  MessageCircle,
  MessageSquare,
  PenTool,
  Send,
  Share2,
  Sparkles,
  User,
  Users,
} from 'lucide-react'
import { useState } from 'react'

interface UseCaseStep {
  icon: LucideIcon
  text: string
}

interface UseCase {
  id: string
  label: string
  icon: LucideIcon
  headline: string
  channel: { label: string; icon: LucideIcon }
  steps: UseCaseStep[]
  footnote: string
}

const USE_CASES: UseCase[] = [
  {
    id: 'personal',
    label: 'Personal',
    icon: User,
    headline: 'Your newsletter digest, in your inbox by 8am.',
    channel: { label: 'Telegram DM', icon: Send },
    steps: [
      { icon: Clock, text: 'A cron job fires a web-research subagent overnight.' },
      { icon: Globe, text: 'It reads and summarizes the newsletters that landed.' },
      { icon: Send, text: 'It posts the digest straight to your Telegram DM.' },
    ],
    footnote: 'Memory remembers which sources you skip, so the next digest skips them too.',
  },
  {
    id: 'team',
    label: 'Team',
    icon: Users,
    headline: 'A PR reviewer on call around the clock.',
    channel: { label: 'GitHub', icon: Github },
    steps: [
      { icon: GitPullRequest, text: 'Request @your-agent as a reviewer on the pull request.' },
      { icon: FileText, text: 'It reads the diff line by line, as a participant in the thread.' },
      { icon: MessageSquare, text: 'It posts a formal review back, with the reasoning attached.' },
    ],
    footnote: 'Add the one tool your team needs in a .ts file you own.',
  },
  {
    id: 'creator',
    label: 'Creator',
    icon: PenTool,
    headline: 'Cross-post once, reply everywhere.',
    channel: { label: 'Slack · Discord · Telegram', icon: Share2 },
    steps: [
      { icon: PenTool, text: 'Draft the post once, in your own words.' },
      { icon: Sparkles, text: 'It adapts the tone to fit each channel before sending.' },
      { icon: MessageCircle, text: 'It triages replies and drafts responses in your voice.' },
    ],
    footnote: 'The voice it learns is plain files you can read and edit.',
  },
]

function UseCaseMock({ id }: { id: string }) {
  if (id === 'personal') {
    return (
      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-white/[0.08] dark:bg-zinc-900">
        <div className="flex items-center gap-2 border-b border-zinc-100 px-4 py-2.5 dark:border-white/[0.06]">
          <span className="flex size-6 items-center justify-center rounded-full bg-brand-600 text-white dark:bg-brand-500">
            <Sparkles className="size-3" strokeWidth={2.4} aria-hidden />
          </span>
          <span className="font-mono text-xs text-zinc-600 dark:text-zinc-300">typeey</span>
          <span className="ml-auto font-mono text-[11px] text-zinc-400 dark:text-zinc-600">08:00</span>
        </div>
        <div className="space-y-2 px-4 py-3 text-sm text-zinc-600 dark:text-zinc-400">
          <p className="text-zinc-800 dark:text-zinc-200">Good morning. Here&apos;s what landed overnight:</p>
          <p className="text-zinc-500 dark:text-zinc-500">— AI Weekly: new model benchmarks</p>
          <p className="text-zinc-500 dark:text-zinc-500">— Frontend Digest: View Transitions ship</p>
        </div>
      </div>
    )
  }
  if (id === 'team') {
    return (
      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-white/[0.08] dark:bg-zinc-900">
        <div className="flex items-center gap-2 border-b border-zinc-100 px-4 py-2.5 dark:border-white/[0.06]">
          <Github className="size-4 text-zinc-500 dark:text-zinc-400" strokeWidth={1.8} aria-hidden />
          <span className="font-mono text-xs text-zinc-600 dark:text-zinc-300">typeey reviewed</span>
          <span className="ml-auto rounded-full bg-amber-50 px-2 py-0.5 font-mono text-[10px] font-medium tracking-wider text-amber-700 uppercase dark:bg-amber-900/30 dark:text-amber-300">
            changes requested
          </span>
        </div>
        <div className="space-y-1.5 px-4 py-3">
          <p className="font-mono text-[11px] text-zinc-400 dark:text-zinc-600">src/auth.ts · line 42</p>
          <p className="text-sm text-zinc-700 dark:text-zinc-300">
            This token isn&apos;t scoped to the request — tighten it before merge.
          </p>
        </div>
      </div>
    )
  }
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-white/[0.08] dark:bg-zinc-900">
      <div className="flex items-center gap-2 border-b border-zinc-100 px-4 py-2.5 dark:border-white/[0.06]">
        <PenTool className="size-4 text-brand-600 dark:text-brand-300" strokeWidth={2.2} aria-hidden />
        <span className="font-mono text-xs text-zinc-600 dark:text-zinc-300">draft → adapted</span>
      </div>
      <div className="space-y-2 px-4 py-3 text-sm">
        <p className="flex items-start gap-2 text-zinc-600 dark:text-zinc-400">
          <span className="mt-0.5 shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] tracking-wider text-zinc-500 uppercase dark:bg-white/[0.06] dark:text-zinc-400">
            slack
          </span>
          Shipped a thing today — quick thread below.
        </p>
        <p className="flex items-start gap-2 text-zinc-600 dark:text-zinc-400">
          <span className="mt-0.5 shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] tracking-wider text-zinc-500 uppercase dark:bg-white/[0.06] dark:text-zinc-400">
            telegram
          </span>
          New release is live. Here&apos;s what changed.
        </p>
      </div>
    </div>
  )
}

export function UseCaseTabs() {
  const [active, setActive] = useState('personal')
  const activeCase = USE_CASES.find((c) => c.id === active)!
  const ChannelIcon = activeCase.channel.icon

  return (
    <div className="mx-auto max-w-3xl">
      <div
        role="tablist"
        aria-label="Use cases"
        className="flex flex-wrap items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white p-1.5 shadow-sm dark:border-white/[0.08] dark:bg-zinc-900"
      >
        {USE_CASES.map((c) => {
          const Icon = c.icon
          const isActive = active === c.id
          return (
            <button
              key={c.id}
              type="button"
              role="tab"
              id={`use-case-tab-${c.id}`}
              aria-selected={isActive}
              aria-controls={`use-case-panel-${c.id}`}
              onClick={() => setActive(c.id)}
              className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition-all min-[420px]:flex-none sm:px-4 ${
                isActive
                  ? 'bg-brand-50 text-brand-700 shadow-sm dark:bg-brand-950/60 dark:text-brand-300'
                  : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-500 dark:hover:text-zinc-200'
              }`}
            >
              <Icon className="size-4" strokeWidth={2.4} aria-hidden />
              {c.label}
            </button>
          )
        })}
      </div>

      <div
        role="tabpanel"
        id={`use-case-panel-${activeCase.id}`}
        aria-labelledby={`use-case-tab-${activeCase.id}`}
        tabIndex={0}
        className="mt-6 grid grid-cols-1 gap-8 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm sm:p-8 lg:grid-cols-2 lg:gap-10 dark:border-white/[0.08] dark:bg-zinc-950"
      >
        <div className="min-w-0">
          <h3 className="text-balance text-xl font-semibold tracking-tight text-zinc-900 sm:text-2xl dark:text-zinc-100">
            {activeCase.headline}
          </h3>
          <ol className="mt-6 space-y-4">
            {activeCase.steps.map((step, i) => {
              const StepIcon = step.icon
              return (
                <li key={i} className="flex items-start gap-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300">
                    <StepIcon className="size-4" strokeWidth={2.2} aria-hidden />
                  </span>
                  <p className="pt-1 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">{step.text}</p>
                </li>
              )
            })}
          </ol>
          <p className="mt-6 border-t border-zinc-100 pt-4 text-sm leading-relaxed text-zinc-500 dark:border-white/[0.06] dark:text-zinc-500">
            {activeCase.footnote}
          </p>
        </div>

        <div className="min-w-0">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1 font-mono text-[11px] font-medium tracking-wider text-zinc-500 uppercase dark:border-white/[0.08] dark:bg-white/[0.02] dark:text-zinc-400">
            <ChannelIcon className="size-3.5" strokeWidth={2.2} aria-hidden />
            {activeCase.channel.label}
          </div>
          <div className="mt-4">
            <UseCaseMock id={activeCase.id} />
          </div>
        </div>
      </div>
    </div>
  )
}
