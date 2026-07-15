import { describe, expect, test } from 'bun:test'

import type { ModelRef } from '@/config/providers'

import { COOLDOWN_MS, THROTTLE_THRESHOLD, THROTTLE_WINDOW_MS, ThrottleCircuit } from './throttle-circuit'

const REF_A = 'openai/gpt-5.4-nano' as ModelRef
const REF_B = 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' as ModelRef
const CODEX_TERRA_REF = 'openai-codex/gpt-5.5' as ModelRef
const CODEX_SOL_REF = 'openai-codex/gpt-5.4' as ModelRef
const CODEX_LUNA_REF = 'openai-codex/gpt-5.4-mini' as ModelRef

describe('ThrottleCircuit', () => {
  test('opens after threshold throttles in the sliding window', () => {
    let t = 1_000
    const circuit = new ThrottleCircuit({ now: () => t })

    circuit.recordThrottle({ profile: 'default', ref: REF_A })
    expect(circuit.isOpen({ profile: 'default', ref: REF_A })).toBe(false)

    t += THROTTLE_WINDOW_MS - 1
    circuit.recordThrottle({ profile: 'default', ref: REF_A })
    expect(THROTTLE_THRESHOLD).toBe(2)
    expect(circuit.isOpen({ profile: 'default', ref: REF_A })).toBe(true)
  })

  test('half-open after cooldown and success closes the circuit', () => {
    let t = 1_000
    const circuit = new ThrottleCircuit({ now: () => t })
    circuit.recordThrottle({ profile: 'default', ref: REF_A })
    circuit.recordThrottle({ profile: 'default', ref: REF_A })
    expect(circuit.isOpen({ profile: 'default', ref: REF_A })).toBe(true)

    t += COOLDOWN_MS + 1
    expect(circuit.isOpen({ profile: 'default', ref: REF_A })).toBe(false)

    circuit.recordSuccess({ profile: 'default', ref: REF_A })
    circuit.recordThrottle({ profile: 'default', ref: REF_A })
    expect(circuit.isOpen({ profile: 'default', ref: REF_A })).toBe(false)
  })

  test('does not share state across refs or profiles', () => {
    const circuit = new ThrottleCircuit({ now: () => 1_000 })
    circuit.recordThrottle({ profile: 'default', ref: REF_A })
    circuit.recordThrottle({ profile: 'default', ref: REF_A })

    expect(circuit.isOpen({ profile: 'default', ref: REF_A })).toBe(true)
    expect(circuit.isOpen({ profile: 'default', ref: REF_B })).toBe(false)
    expect(circuit.isOpen({ profile: 'fast', ref: REF_A })).toBe(false)
  })

  test('shares provider circuit state across refs without opening their ref circuits', () => {
    const circuit = new ThrottleCircuit({ now: () => 1_000 })

    circuit.recordProviderTrip({ profile: 'default', ref: CODEX_TERRA_REF })
    expect(circuit.isProviderOpen({ profile: 'default', ref: CODEX_SOL_REF })).toBe(false)

    circuit.recordProviderTrip({ profile: 'default', ref: CODEX_SOL_REF })
    circuit.recordProviderTrip({ profile: 'default', ref: CODEX_LUNA_REF })

    expect(circuit.isProviderOpen({ profile: 'default', ref: CODEX_TERRA_REF })).toBe(true)
    expect(circuit.isProviderOpen({ profile: 'default', ref: CODEX_LUNA_REF })).toBe(true)
    expect(circuit.isOpen({ profile: 'default', ref: CODEX_TERRA_REF })).toBe(false)
    expect(circuit.isOpen({ profile: 'default', ref: CODEX_SOL_REF })).toBe(false)
    expect(circuit.isOpen({ profile: 'default', ref: CODEX_LUNA_REF })).toBe(false)
  })

  test('provider success clears sub-threshold failures shared by its refs', () => {
    const circuit = new ThrottleCircuit({ now: () => 1_000 })

    circuit.recordProviderTrip({ profile: 'default', ref: CODEX_TERRA_REF })
    circuit.recordSuccess({ profile: 'default', ref: CODEX_SOL_REF })
    circuit.recordProviderTrip({ profile: 'default', ref: CODEX_LUNA_REF })

    expect(circuit.isProviderOpen({ profile: 'default', ref: CODEX_TERRA_REF })).toBe(false)
  })
})
