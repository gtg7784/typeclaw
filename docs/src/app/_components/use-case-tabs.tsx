'use client'

import { User, Users, PenTool } from 'lucide-react'
import { useState } from 'react'

const USE_CASES = [
  {
    id: 'personal',
    label: 'Personal',
    icon: User,
    text: 'Summarize newsletters, manage your calendar, remember how you like things done — and open memory/ in git to see exactly what it learned about you. Your assistant, your data, your folder.',
  },
  {
    id: 'team',
    label: 'Team',
    icon: Users,
    text: 'Review PRs, triage issues, keep the standup notes. Add the one tool your team needs in a .ts file you actually own — no waiting on a marketplace, no plugin language to learn.',
  },
  {
    id: 'creator',
    label: 'Creator',
    icon: PenTool,
    text: 'Pipeline content, cross-post to channels, reply to your audience. As it learns your voice, that memory is plain files you can read and edit — never a black box you have to trust.',
  },
]

export function UseCaseTabs() {
  const [active, setActive] = useState('personal')
  const activeCase = USE_CASES.find((c) => c.id === active)!

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex flex-wrap items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white p-1.5 shadow-sm dark:border-white/[0.08] dark:bg-zinc-900">
        {USE_CASES.map((c) => {
          const Icon = c.icon
          const isActive = active === c.id
          return (
            <button
              key={c.id}
              onClick={() => setActive(c.id)}
              className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition-all min-[420px]:flex-none sm:px-4 ${
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
        <p className="mx-auto max-w-lg text-base leading-relaxed text-zinc-600 dark:text-zinc-400">{activeCase.text}</p>
      </div>
    </div>
  )
}
