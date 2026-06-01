import { describe, expect, test } from 'bun:test'

import { formatChannelReloadSummary } from './format'

describe('formatChannelReloadSummary', () => {
  test('empty results', () => {
    expect(formatChannelReloadSummary([])).toBe('Nothing to reload.')
  })

  test('all ok → pass headline, one line per scope', () => {
    const out = formatChannelReloadSummary([
      { scope: 'config', ok: true, summary: 'no changes' },
      { scope: 'cron', ok: true, summary: '2 jobs' },
    ])
    expect(out).toBe(['Reloaded 2 subsystem(s).', '• config: no changes', '• cron: 2 jobs'].join('\n'))
  })

  test('a failure is counted in the headline and surfaces its reason', () => {
    const out = formatChannelReloadSummary([
      { scope: 'config', ok: false, reason: 'invalid JSON' },
      { scope: 'cron', ok: true, summary: 'ok' },
    ])
    expect(out).toBe(['Reloaded 2 subsystem(s); 1 failed.', '• config: failed — invalid JSON', '• cron: ok'].join('\n'))
  })
})
