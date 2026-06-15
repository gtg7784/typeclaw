'use client'

import { useEffect, useState } from 'react'

interface Segment {
  text: string
  className: string
}

const SCRIPT: Segment[] = [
  { text: '$ ', className: 'text-zinc-400 dark:text-zinc-600' },
  { text: 'typeclaw init', className: 'text-zinc-800 dark:text-zinc-100' },
  { text: '\n', className: '' },
  { text: '? ', className: 'text-brand-700 dark:text-brand-300' },
  { text: 'Provider  ', className: 'text-zinc-600 dark:text-zinc-400' },
  { text: 'openai · gpt-5.5', className: 'text-zinc-500 dark:text-zinc-500' },
  { text: '\n', className: '' },
  { text: '? ', className: 'text-brand-700 dark:text-brand-300' },
  { text: 'Channel   ', className: 'text-zinc-600 dark:text-zinc-400' },
  { text: 'slack-bot ✓ connected', className: 'text-zinc-500 dark:text-zinc-500' },
  { text: '\n', className: '' },
  { text: 'Egg laid. 🥚 ', className: 'text-zinc-600 dark:text-zinc-400' },
  { text: '●', className: 'text-brand-700 dark:text-brand-300' },
  { text: ' my-agent hatched on host port 8973', className: 'text-zinc-600 dark:text-zinc-400' },
  { text: '\n\n', className: '' },

  { text: '$ ', className: 'text-zinc-400 dark:text-zinc-600' },
  { text: 'git log memory/ --oneline', className: 'text-zinc-800 dark:text-zinc-100' },
  { text: '\n', className: '' },
  { text: 'a3f2c1d', className: 'text-zinc-500 dark:text-zinc-500' },
  { text: " dream: 4 fragments + new skill 'pr-review' 🔮", className: 'text-zinc-600 dark:text-zinc-400' },
]

const TOTAL_CHARS = SCRIPT.reduce((sum, s) => sum + s.text.length, 0)
const TYPE_INTERVAL_MS = 28
const PAUSE_AFTER_DONE_MS = 4000

interface Props {
  variant?: 'default' | 'flat' | 'glow'
  title?: string
  className?: string
}

export function AnimatedTerminal({ variant = 'default', title = 'my-agent', className }: Props) {
  const [chars, setChars] = useState(0)

  useEffect(() => {
    if (chars >= TOTAL_CHARS) {
      const reset = setTimeout(() => setChars(0), PAUSE_AFTER_DONE_MS)
      return () => clearTimeout(reset)
    }
    const delay = chars === 0 ? 600 : TYPE_INTERVAL_MS
    const next = setTimeout(() => setChars(chars + 1), delay)
    return () => clearTimeout(next)
  }, [chars])

  let remaining = chars
  const rendered: Array<{ text: string; className: string; key: number }> = []
  const ghost: Array<{ text: string; key: number }> = []
  for (let i = 0; i < SCRIPT.length; i++) {
    const seg = SCRIPT[i]
    const visible = remaining > 0 ? seg.text.slice(0, remaining) : ''
    const hidden = seg.text.slice(visible.length)
    if (visible) rendered.push({ text: visible, className: seg.className, key: i })
    if (hidden) ghost.push({ text: hidden, key: i })
    remaining -= visible.length
  }

  const isDone = chars >= TOTAL_CHARS
  const containerClass =
    variant === 'flat'
      ? 'overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-white/[0.08] dark:bg-zinc-950'
      : variant === 'glow'
        ? 'relative overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-[0_24px_80px_-24px_rgba(22,40,89,0.18)] ring-1 ring-brand-100/60 dark:border-white/[0.08] dark:bg-zinc-950 dark:shadow-[0_24px_80px_-12px_rgba(0,0,0,0.6)] dark:ring-brand-900/40'
        : 'overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-[0_1px_0_0_rgba(0,0,0,0.02)] dark:border-white/[0.08] dark:bg-zinc-950'

  return (
    <div className={`${containerClass}${className ? ` ${className}` : ''}`}>
      <div className="flex items-center justify-between border-b border-zinc-100 bg-zinc-50 px-4 py-2.5 dark:border-white/[0.04] dark:bg-white/[0.02]">
        <div className="flex gap-1.5">
          <span className="size-2.5 rounded-full bg-zinc-300 dark:bg-zinc-700" />
          <span className="size-2.5 rounded-full bg-zinc-300 dark:bg-zinc-700" />
          <span className="size-2.5 rounded-full bg-zinc-300 dark:bg-zinc-700" />
        </div>
        <span className="font-mono text-xs text-zinc-400 dark:text-zinc-600">{title}</span>
        <span className="size-2.5" />
      </div>
      <pre
        className="overflow-x-auto p-4 font-mono text-xs leading-relaxed sm:p-5 sm:text-[13px]"
        aria-label="Animated terminal demo: typeclaw init wires a provider and channel and hatches the agent, then git log shows it already dreaming"
      >
        <code>
          {rendered.map((seg) => (
            <span key={seg.key} className={seg.className}>
              {seg.text}
            </span>
          ))}
          <span
            aria-hidden
            className={`inline-block w-[7px] translate-y-[2px] bg-brand-600 dark:bg-brand-300 ${
              isDone ? 'animate-pulse' : ''
            }`}
            style={{ height: '1em' }}
          />
          {ghost.map((seg) => (
            <span key={`ghost-${seg.key}`} aria-hidden className="text-transparent">
              {seg.text}
            </span>
          ))}
        </code>
      </pre>
    </div>
  )
}
