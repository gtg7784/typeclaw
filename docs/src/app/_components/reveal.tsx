'use client'

import { useEffect, useLayoutEffect, useRef } from 'react'

interface RevealProps {
  children: React.ReactNode
  className?: string
  delay?: number
}

// useLayoutEffect would warn on SSR — there's no DOM to read or mutate.
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

export function Reveal({ children, className = '', delay = 0 }: RevealProps) {
  const ref = useRef<HTMLDivElement>(null)

  useIsomorphicLayoutEffect(() => {
    const el = ref.current
    if (!el) return

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    if (typeof IntersectionObserver === 'undefined') return

    // Above-the-fold elements stay visible — no need to hide/reveal them.
    const rect = el.getBoundingClientRect()
    if (rect.top < window.innerHeight && rect.bottom > 0) return

    // Progressive enhancement: SSR rendered the element visible (so users
    // without JS or with delayed hydration still see the content). Now that
    // JS is in control, snap to the hidden starting state without a
    // transition, then let the IntersectionObserver fade it in on scroll.
    el.style.transitionProperty = 'none'
    el.style.opacity = '0'
    el.style.translate = '0 2rem'
    void el.offsetHeight // flush styles before re-enabling transitions
    el.style.transitionProperty = ''

    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            el.style.removeProperty('opacity')
            el.style.removeProperty('translate')
            obs.unobserve(entry.target)
          }
        }
      },
      { threshold: 0, rootMargin: '0px 0px -10% 0px' },
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  return (
    <div
      ref={ref}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
      className={`translate-y-0 opacity-100 transition-[opacity,translate] duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${className}`}
    >
      {children}
    </div>
  )
}
