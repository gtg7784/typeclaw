'use client'

import Image from 'next/image'
import { useEffect, useId, useRef, useState } from 'react'

const DISCORD_INVITE_URL = 'https://discord.gg/V4NQnbXpr'

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419-.0189 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1568 2.4189z" />
    </svg>
  )
}

function HelpIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <path d="M12 17h.01" />
    </svg>
  )
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  )
}

export function AskTypeey() {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const panelId = useId()

  useEffect(() => {
    if (!open) return

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }

    function onPointerDown(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open])

  return (
    <div ref={containerRef} className="fixed right-4 bottom-4 z-50 sm:right-6 sm:bottom-6">
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label="Ask Typeey"
          className="ask-typeey-panel absolute right-0 bottom-full mb-3 w-[min(20rem,calc(100vw-2rem))] origin-bottom-right overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl shadow-zinc-900/10 dark:border-white/[0.1] dark:bg-zinc-900 dark:shadow-black/40"
        >
          <div className="flex items-center gap-3 border-b border-zinc-100 bg-gradient-to-br from-brand-50 to-white px-4 py-3.5 dark:border-white/[0.06] dark:from-brand-950/40 dark:to-zinc-900">
            <div className="relative">
              <Image
                src="/typeey.png"
                alt=""
                width={36}
                height={36}
                className="rounded-full ring-2 ring-white dark:ring-zinc-800"
              />
              <span
                aria-hidden
                className="absolute right-0 bottom-0 size-2.5 rounded-full bg-emerald-500 ring-2 ring-white dark:ring-zinc-900"
              />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">Typeey</p>
              <p className="text-[11px] text-emerald-600 dark:text-emerald-400">Online in Discord</p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="-mr-1 flex size-7 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-white/[0.06] dark:hover:text-zinc-200"
            >
              <CloseIcon className="size-4" />
            </button>
          </div>

          <div className="px-4 py-4">
            <div className="rounded-2xl rounded-tl-sm bg-zinc-100 px-3.5 py-2.5 text-sm leading-relaxed text-zinc-700 dark:bg-white/[0.06] dark:text-zinc-300">
              Hey! Questions, ideas, or just want to say hi? The whole community hangs out on Discord — come chat with
              us.
            </div>

            <a
              href={DISCORD_INVITE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 flex w-full items-center justify-center gap-2.5 rounded-xl bg-[#5865F2] px-4 py-3 text-sm font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:bg-[#4752c4] hover:shadow-md focus-visible:ring-2 focus-visible:ring-[#5865F2] focus-visible:ring-offset-2 focus-visible:outline-none motion-reduce:transition-none dark:focus-visible:ring-offset-zinc-900"
            >
              <DiscordIcon className="size-5" />
              Join us on Discord
            </a>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={open ? 'Close Ask Typeey' : 'Ask Typeey'}
        className="group ml-auto flex items-center gap-2.5 rounded-full bg-brand-accent py-3 pr-5 pl-4 font-medium text-white shadow-lg shadow-brand-accent/30 transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-xl focus-visible:ring-2 focus-visible:ring-brand-accent focus-visible:ring-offset-2 focus-visible:outline-none motion-reduce:transition-none dark:bg-brand-600 dark:shadow-brand-600/30 dark:focus-visible:ring-offset-zinc-950"
      >
        {open ? <CloseIcon className="size-5 shrink-0" /> : <HelpIcon className="size-5 shrink-0" />}
        <span className="text-sm tracking-tight whitespace-nowrap">Ask Typeey</span>
      </button>
    </div>
  )
}
