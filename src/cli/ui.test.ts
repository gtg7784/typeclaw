import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { c, errorLine, link, renderStartSuccess, spinner, successLine, type StartLikeResult } from './ui'

const ENV_KEYS = ['NO_COLOR', 'FORCE_COLOR'] as const

function withForcedColor<T>(fn: () => T): T {
  const prev: Record<string, string | undefined> = {}
  for (const k of ENV_KEYS) prev[k] = process.env[k]
  process.env.NO_COLOR = ''
  process.env.FORCE_COLOR = '1'
  try {
    return fn()
  } finally {
    for (const k of ENV_KEYS) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
  }
}

function withNoColor<T>(fn: () => T): T {
  const prev: Record<string, string | undefined> = {}
  for (const k of ENV_KEYS) prev[k] = process.env[k]
  process.env.NO_COLOR = '1'
  delete process.env.FORCE_COLOR
  try {
    return fn()
  } finally {
    for (const k of ENV_KEYS) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
  }
}

describe('c.*', () => {
  test('wraps text with cyan ANSI when colors are forced', () => {
    const out = withForcedColor(() => c.cyan('hello'))
    expect(out).toContain('hello')
    expect(out).toContain('\u001b[36m')
  })

  test('returns the raw string when NO_COLOR is set', () => {
    const out = withNoColor(() => c.cyan('hello'))
    expect(out).toBe('hello')
  })

  test('every color helper preserves the input text', () => {
    withForcedColor(() => {
      for (const key of ['cyan', 'green', 'red', 'yellow', 'dim', 'gray', 'magenta', 'bold'] as const) {
        expect(c[key]('PAYLOAD')).toContain('PAYLOAD')
      }
    })
  })

  test('bold uses the bold ANSI code under forced color', () => {
    const out = withForcedColor(() => c.bold('X'))
    expect(out).toContain('\u001b[1m')
  })
})

describe('link', () => {
  test('emits OSC 8 sequence around the text when colors are on', () => {
    const out = withForcedColor(() => link('Docs', 'https://example.com'))
    expect(out).toContain('Docs')
    expect(out).toContain('https://example.com')
    expect(out).toContain('\u001b]8;;')
  })

  test('falls back to "text (url)" when NO_COLOR is set', () => {
    const out = withNoColor(() => link('Docs', 'https://example.com'))
    expect(out).toBe('Docs (https://example.com)')
  })
})

describe('renderStartSuccess', () => {
  function baseResult(overrides: Partial<StartLikeResult> = {}): StartLikeResult {
    return {
      built: false,
      plan: { containerName: 'coder', imageTag: 'typeclaw-coder' },
      hostPort: 8973,
      containerId: 'abcdef0123456789',
      hostd: { state: 'registered' },
      ...overrides,
    }
  }

  test('renders the "started" path with container name, port, and short id', () => {
    const out = withNoColor(() => renderStartSuccess(baseResult()))
    expect(out).toContain('coder')
    expect(out).toContain('started on host port 8973')
    expect(out).toContain('abcdef012345')
    expect(out).not.toContain('abcdef0123456789')
  })

  test('renders the "already running" path with the same name + port', () => {
    const out = withNoColor(() => renderStartSuccess(baseResult({ alreadyRunning: true })))
    expect(out).toContain('coder')
    expect(out).toContain('is already running on host port 8973')
    expect(out).not.toContain('started on host port')
  })

  test('renders a "Built image" line only when built is true', () => {
    const builtOut = withNoColor(() => renderStartSuccess(baseResult({ built: true })))
    expect(builtOut).toContain('Built image typeclaw-coder.')

    const unbuiltOut = withNoColor(() => renderStartSuccess(baseResult({ built: false })))
    expect(unbuiltOut).not.toContain('Built image')
  })

  test('renders "Host daemon active." when hostd is registered', () => {
    const out = withNoColor(() => renderStartSuccess(baseResult()))
    expect(out).toContain('Host daemon active.')
  })

  test('renders a yellow warning line when hostd is unavailable', () => {
    const out = withForcedColor(() =>
      renderStartSuccess(baseResult({ hostd: { state: 'unavailable', reason: 'socket missing' } })),
    )
    expect(out).toContain('Host daemon unavailable:')
    expect(out).toContain('socket missing')
    expect(out).toContain('\u001b[33m')
  })

  test('omits the hostd line entirely when hostd is disabled', () => {
    const out = withNoColor(() => renderStartSuccess(baseResult({ hostd: { state: 'disabled' } })))
    expect(out).not.toContain('Host daemon')
  })

  test('always includes the three next-step command hints', () => {
    const out = withNoColor(() => renderStartSuccess(baseResult()))
    expect(out).toContain('typeclaw logs -f')
    expect(out).toContain('typeclaw tui')
    expect(out).toContain('typeclaw stop')
  })

  test('color-wraps the port number under forced color', () => {
    const out = withForcedColor(() => renderStartSuccess(baseResult()))
    expect(out).toContain('\u001b[32m8973')
    expect(out).toContain('\u001b[36mcoder')
  })
})

describe('errorLine / successLine', () => {
  test('errorLine prefixes with a red ✖', () => {
    const out = withForcedColor(() => errorLine('something broke'))
    expect(out).toContain('something broke')
    expect(out).toContain('✖')
    expect(out).toContain('\u001b[31m')
  })

  test('successLine prefixes with a green ●', () => {
    const out = withForcedColor(() => successLine('did the thing'))
    expect(out).toContain('did the thing')
    expect(out).toContain('●')
    expect(out).toContain('\u001b[32m')
  })

  test('neither emits color escapes under NO_COLOR', () => {
    withNoColor(() => {
      expect(errorLine('x')).toBe('✖ x')
      expect(successLine('y')).toBe('● y')
    })
  })
})

describe('spinner', () => {
  const originalIsTTY = process.stdout.isTTY

  beforeEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
  })

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true })
  })

  test('start/stop/message/error do not throw on a non-TTY stdout', () => {
    const s = spinner()
    expect(() => {
      s.start('working...')
      s.message('still working')
      s.stop('done')
    }).not.toThrow()
  })

  test('error() finalizes the spinner with a non-zero code', () => {
    const s = spinner()
    expect(() => {
      s.start('working...')
      s.error('boom')
    }).not.toThrow()
  })
})
