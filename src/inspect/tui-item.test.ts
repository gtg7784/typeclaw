import { describe, expect, test } from 'bun:test'

import { runTuiViewer } from './tui-item'

const noopSleep = async (): Promise<void> => {}

describe('runTuiViewer', () => {
  test('detach maps to escToPicker (back to the list)', async () => {
    const result = await runTuiViewer({
      resolveUrl: async () => 'ws://x',
      runTui: async () => ({ reason: 'detach' }),
      stderr: () => {},
      sleep: noopSleep,
    })

    expect(result).toEqual({ ok: true, exitCode: 0, escToPicker: true })
  })

  test('exit maps to a terminal result with the exit code', async () => {
    const result = await runTuiViewer({
      resolveUrl: async () => 'ws://x',
      runTui: async () => ({ reason: 'exit', exitCode: 0 }),
      stderr: () => {},
      sleep: noopSleep,
    })

    expect(result).toEqual({ ok: true, exitCode: 0 })
  })

  test('lostConnection reconnects, re-resolving the URL and clearing the initial prompt', async () => {
    const resolvedUrls: string[] = []
    const prompts: (string | undefined)[] = []
    let calls = 0

    const result = await runTuiViewer({
      resolveUrl: async () => {
        const url = `ws://attempt-${resolvedUrls.length}`
        resolvedUrls.push(url)
        return url
      },
      initialPrompt: 'hello',
      runTui: async (opts) => {
        prompts.push(opts.initialPrompt)
        calls++
        if (calls === 1) return { reason: 'lostConnection' }
        return { reason: 'detach' }
      },
      stderr: () => {},
      sleep: noopSleep,
    })

    expect(result).toEqual({ ok: true, exitCode: 0, escToPicker: true })
    expect(resolvedUrls).toEqual(['ws://attempt-0', 'ws://attempt-1'])
    expect(prompts).toEqual(['hello', undefined])
  })

  test('gives up after the reconnect cap and returns an error result', async () => {
    const result = await runTuiViewer({
      resolveUrl: async () => 'ws://x',
      runTui: async () => ({ reason: 'lostConnection' }),
      reconnectMaxAttempts: 2,
      stderr: () => {},
      sleep: noopSleep,
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.exitCode).toBe(1)
    expect(result.reason).toContain('gave up after 2')
  })

  test('a resolveUrl failure returns an error result without launching the tui', async () => {
    let launched = false
    const result = await runTuiViewer({
      resolveUrl: async () => {
        throw new Error('container not running')
      },
      runTui: async () => {
        launched = true
        return { reason: 'detach' }
      },
      stderr: () => {},
      sleep: noopSleep,
    })

    expect(launched).toBe(false)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('container not running')
  })
})
