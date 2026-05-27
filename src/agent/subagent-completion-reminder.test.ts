import { describe, expect, test } from 'bun:test'

import {
  formatReminderDuration,
  parseSubagentCompletedPayload,
  renderSubagentCompletionReminder,
} from './subagent-completion-reminder'

describe('renderSubagentCompletionReminder', () => {
  test('ok=true renders <system-reminder> with subagent name, task id, duration, and subagent_output hint', () => {
    const text = renderSubagentCompletionReminder({
      subagent: 'explorer',
      taskId: 'bg_xyz',
      ok: true,
      durationMs: 5_000,
    })
    expect(text.startsWith('<system-reminder>')).toBe(true)
    expect(text.endsWith('</system-reminder>')).toBe(true)
    expect(text).toContain('explorer')
    expect(text).toContain('bg_xyz')
    expect(text).toContain('5s')
    expect(text).toContain('completed')
    expect(text).toContain('subagent_output')
  })

  test('ok=false renders FAILED marker, error message, and subagent_output hint', () => {
    const text = renderSubagentCompletionReminder({
      subagent: 'scout',
      taskId: 'bg_err',
      ok: false,
      durationMs: 1_500,
      error: 'provider rate limit',
    })
    expect(text).toContain('FAILED')
    expect(text).toContain('provider rate limit')
    expect(text).toContain('subagent_output')
  })

  test('ok=false without error string falls back to "unknown error"', () => {
    const text = renderSubagentCompletionReminder({
      subagent: 'scout',
      taskId: 'bg_err',
      ok: false,
      durationMs: 1_500,
    })
    expect(text).toContain('unknown error')
  })

  test('channel=true appends the channel_reply nudge so a channel-session reminder steers the model to surface via tool, not plain text', () => {
    const text = renderSubagentCompletionReminder({
      subagent: 'explorer',
      taskId: 'bg_xyz',
      ok: true,
      durationMs: 5_000,
      channel: true,
    })
    expect(text).toContain('channel_reply')
    expect(text).toContain('channel_send')
    expect(text).toContain('NO_REPLY')
    expect(text).toContain('invisible')
  })

  test('channel=true names the deferred-reply contract: this turn is when the promised reply lands', () => {
    const text = renderSubagentCompletionReminder({
      subagent: 'explorer',
      taskId: 'bg_xyz',
      ok: true,
      durationMs: 5_000,
      channel: true,
    })
    expect(text).toMatch(/promised reply lands/i)
    expect(text).toContain('subagent_output')
    // The "empty / duplicate" silent-turn carve-out now points at
    // skip_response (structured, logs reason) with NO_REPLY as legacy
    // fallback. Pin BOTH phrases so a future refactor that drops one
    // surfaces here instead of silently regressing the guidance.
    expect(text).toContain('skip_response')
    expect(text).toMatch(/genuinely empty or duplicates/i)
    expect(text).toContain('legacy fallback')
  })

  test('channel=true on a FAILED reminder also appends the nudge (failure still needs surfacing)', () => {
    const text = renderSubagentCompletionReminder({
      subagent: 'scout',
      taskId: 'bg_err',
      ok: false,
      durationMs: 1_500,
      error: 'rate limit',
      channel: true,
    })
    expect(text).toContain('FAILED')
    expect(text).toContain('rate limit')
    expect(text).toContain('channel_reply')
  })

  test('channel undefined / false: no channel_reply nudge (TUI/cron paths keep the existing wording)', () => {
    const tuiText = renderSubagentCompletionReminder({
      subagent: 'explorer',
      taskId: 'bg_xyz',
      ok: true,
      durationMs: 5_000,
    })
    expect(tuiText).not.toContain('channel_reply')
    expect(tuiText).not.toContain('invisible')

    const explicitFalse = renderSubagentCompletionReminder({
      subagent: 'explorer',
      taskId: 'bg_xyz',
      ok: true,
      durationMs: 5_000,
      channel: false,
    })
    expect(explicitFalse).not.toContain('channel_reply')
  })
})

describe('formatReminderDuration', () => {
  test('sub-second values render in ms', () => {
    expect(formatReminderDuration(0)).toBe('0ms')
    expect(formatReminderDuration(999)).toBe('999ms')
  })

  test('sub-minute values render in s', () => {
    expect(formatReminderDuration(1_000)).toBe('1s')
    expect(formatReminderDuration(59_999)).toBe('59s')
  })

  test('values >= 1 minute render as Xm Ys', () => {
    expect(formatReminderDuration(60_000)).toBe('1m0s')
    expect(formatReminderDuration(90_500)).toBe('1m30s')
    expect(formatReminderDuration(3_600_000)).toBe('60m0s')
  })
})

describe('parseSubagentCompletedPayload', () => {
  test('valid payload narrows to SubagentCompletedPayload with all fields preserved', () => {
    const parsed = parseSubagentCompletedPayload({
      kind: 'subagent.completed',
      taskId: 'bg_xyz',
      subagent: 'explorer',
      parentSessionId: 'ses_abc',
      ok: true,
      durationMs: 5_000,
    })
    expect(parsed).not.toBeNull()
    expect(parsed!.taskId).toBe('bg_xyz')
    expect(parsed!.subagent).toBe('explorer')
    expect(parsed!.parentSessionId).toBe('ses_abc')
    expect(parsed!.ok).toBe(true)
    expect(parsed!.durationMs).toBe(5_000)
    expect(parsed!.error).toBeUndefined()
  })

  test('failed-completion payload preserves error string', () => {
    const parsed = parseSubagentCompletedPayload({
      kind: 'subagent.completed',
      taskId: 'bg_err',
      subagent: 'scout',
      parentSessionId: 'ses_abc',
      ok: false,
      durationMs: 1_500,
      error: 'provider rate limit',
    })
    expect(parsed?.ok).toBe(false)
    expect(parsed?.error).toBe('provider rate limit')
  })

  test('non-completion kind returns null', () => {
    expect(parseSubagentCompletedPayload({ kind: 'tunnel-url-changed', parentSessionId: 'ses_abc' })).toBeNull()
    expect(parseSubagentCompletedPayload({ kind: 'noise' })).toBeNull()
  })

  test("missing parentSessionId returns null (can't route without it)", () => {
    expect(
      parseSubagentCompletedPayload({
        kind: 'subagent.completed',
        taskId: 'bg_xyz',
        subagent: 'explorer',
        ok: true,
        durationMs: 0,
      }),
    ).toBeNull()
  })

  test('non-object payloads return null', () => {
    expect(parseSubagentCompletedPayload(null)).toBeNull()
    expect(parseSubagentCompletedPayload(undefined)).toBeNull()
    expect(parseSubagentCompletedPayload('string')).toBeNull()
    expect(parseSubagentCompletedPayload(42)).toBeNull()
  })

  test('malformed fields fall back to defaults (taskId="<unknown>", subagent="subagent", durationMs=0, ok=false)', () => {
    const parsed = parseSubagentCompletedPayload({
      kind: 'subagent.completed',
      parentSessionId: 'ses_abc',
    })
    expect(parsed?.taskId).toBe('<unknown>')
    expect(parsed?.subagent).toBe('subagent')
    expect(parsed?.durationMs).toBe(0)
    expect(parsed?.ok).toBe(false)
  })
})
