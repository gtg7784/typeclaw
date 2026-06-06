import { describe, expect, test } from 'bun:test'

import { formatLocalDateTime, resolveLocalTimezoneName } from '@/shared'

import { DEFAULT_SYSTEM_PROMPT, renderTurnRoleAnchor, renderTurnTimeAnchor } from './system-prompt'

describe('subagent orchestration — explicit research routing', () => {
  // Guards the regression where an explicit "do a research" directive was answered
  // inline (web_search / training memory) instead of delegated. The invariant the
  // reviewer demanded: explicit research is MANDATORY-`researcher`, not satisfiable
  // by a scout/explorer-only route or an inline answer. Soften any of these and the
  // downgrade path reopens.
  test('explicit research mandates `researcher` and forbids the inline-answer downgrade', () => {
    const ruleStart = DEFAULT_SYSTEM_PROMPT.indexOf('When the user *explicitly* says')
    expect(ruleStart).toBeGreaterThan(-1)
    const rule = DEFAULT_SYSTEM_PROMPT.slice(ruleStart, ruleStart + 320)
    expect(rule).toContain('MUST spawn `researcher`')
    expect(rule).toContain('training memory')
    expect(rule).toContain('does not satisfy the request')
  })

  test('scout/explorer fan-out is explicitly marked as not replacing `researcher`', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('does not replace `researcher`')
  })
})

describe('renderTurnTimeAnchor', () => {
  test('wraps the ISO timestamp, IANA zone, and weekday in a single <current-time> tag', () => {
    const now = new Date('2026-01-15T12:00:00+09:00')

    const anchor = renderTurnTimeAnchor(now)

    expect(anchor.startsWith('<current-time>')).toBe(true)
    expect(anchor.endsWith('</current-time>')).toBe(true)
    expect(anchor).toContain(formatLocalDateTime(now))
    expect(anchor).toContain(`(${resolveLocalTimezoneName()},`)
  })

  test('emits the English weekday name (global users get one canonical language, not a localized pair)', () => {
    // Asserting membership in the canonical 7-entry list rather than a
    // specific weekday: the local zone may differ on CI from the
    // zone-agnostic constructor input, so the resolved weekday is not
    // pinnable. The contract is "an English weekday is present", not
    // "this specific day".
    const now = new Date('2026-01-15T12:00:00+09:00')

    const anchor = renderTurnTimeAnchor(now)

    const englishDays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    expect(englishDays.some((d) => anchor.includes(d))).toBe(true)
    const koreanDays = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일']
    expect(koreanDays.some((d) => anchor.includes(d))).toBe(false)
  })

  test('produces a single-line block with no internal newlines (so prepending `${anchor}\\n\\n${user}` is the only newline boundary)', () => {
    const now = new Date('2026-01-15T12:00:00+09:00')

    const anchor = renderTurnTimeAnchor(now)

    expect(anchor).not.toContain('\n')
  })

  test('defaults to new Date() when no argument is passed (production callers use this path)', () => {
    const before = Date.now()
    const anchor = renderTurnTimeAnchor()
    const after = Date.now()

    expect(anchor).toContain('<current-time>')
    expect(anchor).toContain('</current-time>')
    const match = anchor.match(/<current-time>(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/)
    expect(match).not.toBeNull()
    const ts = new Date(match![1]!).getTime()
    expect(ts).toBeGreaterThanOrEqual(before - 1000)
    expect(ts).toBeLessThanOrEqual(after + 1000)
  })

  test('the weekday matches what `Date.getDay()` would resolve in the runtime zone (the anchor must agree with `date` for the current local day)', () => {
    const now = new Date()
    const anchor = renderTurnTimeAnchor(now)

    const englishDays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    const expectedEn = englishDays[now.getDay()]!
    expect(anchor).toContain(expectedEn)
  })
})

describe('renderTurnRoleAnchor', () => {
  test('wraps a non-owner role in an authoritative <your-role> tag with override instruction', () => {
    expect(renderTurnRoleAnchor('guest')).toBe(
      '<your-role authority="current-speaker">guest</your-role> (authoritative for this message; overrides any role implied by the system prompt)',
    )
    expect(renderTurnRoleAnchor('member')).toContain('<your-role authority="current-speaker">member</your-role>')
    expect(renderTurnRoleAnchor('trusted')).toContain('<your-role authority="current-speaker">trusted</your-role>')
  })

  test('marks the per-turn role as authoritative so it overrides the cached system-prompt role block', () => {
    const anchor = renderTurnRoleAnchor('guest')!
    expect(anchor).toContain('authoritative')
    expect(anchor).toContain('overrides')
  })

  test('omits the tag for owner (the unconstrained default — absent means no special handling)', () => {
    expect(renderTurnRoleAnchor('owner')).toBeUndefined()
  })

  test('produces a single-line block with no internal newlines', () => {
    expect(renderTurnRoleAnchor('guest')).not.toContain('\n')
  })

  test('passes through a custom role name verbatim', () => {
    expect(renderTurnRoleAnchor('contributor')).toContain(
      '<your-role authority="current-speaker">contributor</your-role>',
    )
  })
})
