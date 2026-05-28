'use client'

import { useState } from 'react'
import { User, Users, PenTool } from 'lucide-react'

const USE_CASES = [
  {
    id: 'personal',
    label: 'Personal',
    icon: User,
    text: 'Track your reading list, summarize newsletters, manage your calendar, remember your preferences — one agent that learns how you work.',
  },
  {
    id: 'team',
    label: 'Team',
    icon: Users,
    text: 'Review code, triage issues, deploy with confidence, keep the standup notes — your agent knows your codebase and your team.',
  },
  {
    id: 'creator',
    label: 'Creator',
    icon: PenTool,
    text: 'Pipeline content, cross-post to channels, reply to audience, track analytics — an agent that grows with your brand.',
  },
]

export function UseCaseTabs() {
  const [active, setActive] = useState('personal')
  const activeCase = USE_CASES.find((c) => c.id === active)!

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white p-1.5 shadow-sm dark:border-white/[0.08] dark:bg-zinc-900">
        {USE_CASES.map((c) => {
          const Icon = c.icon
          const isActive = active === c.id
          return (
            <button
              key={c.id}
              onClick={() => setActive(c.id)}
              className={`flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-all ${
                isActive
                  ? 'bg-brand-50 text-brand-700 shadow-sm dark:bg-brand-950/60 dark:text-brand-300'
                  : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-500 dark:hover:text-zinc-200'
              }`}
            >
              <Icon className="size-4" strokeWidth={2.4} />
              {c.label}
            </button>
          )
        })}
      </div>
      <div className="mt-6 rounded-2xl border border-zinc-200 bg-white p-8 text-center shadow-sm dark:border-white/[0.08] dark:bg-zinc-950">
        <p className="mx-auto max-w-lg text-base leading-relaxed text-zinc-600 dark:text-zinc-400">
          {activeCase.text}
        </p>
      </div>
    </div>
  )
}
