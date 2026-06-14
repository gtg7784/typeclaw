'use client'

import { useEffect, useRef } from 'react'

interface HeroSpotlightProps {
  children: React.ReactNode
  className?: string
}

export function HeroSpotlight({ children, className = '' }: HeroSpotlightProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    let rafId = 0
    let nextX = 50
    let nextY = 30

    const apply = () => {
      rafId = 0
      el.style.setProperty('--mx', `${nextX}%`)
      el.style.setProperty('--my', `${nextY}%`)
    }

    const schedule = () => {
      if (rafId === 0) rafId = requestAnimationFrame(apply)
    }

    const onMove = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect()
      nextX = ((e.clientX - rect.left) / rect.width) * 100
      nextY = ((e.clientY - rect.top) / rect.height) * 100
      schedule()
    }

    const onLeave = () => {
      nextX = 50
      nextY = 30
      schedule()
    }

    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerleave', onLeave)
    return () => {
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerleave', onLeave)
      if (rafId !== 0) cancelAnimationFrame(rafId)
    }
  }, [])

  return (
    <div
      ref={ref}
      className={`hero-spotlight ${className}`}
      style={{ ['--mx' as string]: '50%', ['--my' as string]: '30%' }}
    >
      <div aria-hidden className="hero-spotlight-glow" />
      {children}
    </div>
  )
}
