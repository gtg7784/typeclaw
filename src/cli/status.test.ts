import { describe, expect, test } from 'bun:test'

import { formatStatus, parseStatusResult, type StatusReport } from './status'

function baseReport(overrides: Partial<StatusReport> = {}): StatusReport {
  return {
    cwd: '/agents/coder',
    container: { kind: 'missing', containerName: 'coder', imageTag: 'typeclaw-coder' },
    hostd: { kind: 'unreachable' },
    ...overrides,
  }
}

describe('formatStatus', () => {
  test('renders three sections with labels for missing container + unreachable daemon', () => {
    const out = formatStatus(baseReport())

    expect(out).toContain('Container  coder')
    expect(out).toContain('  cwd     /agents/coder')
    expect(out).toContain('  image   typeclaw-coder')
    expect(out).toContain('  state   missing')
    expect(out).toContain('Host daemon')
    expect(out).toContain('  state   unreachable')
    expect(out).toContain('Port forwarding')
    expect(out).toContain('requires the host daemon')
  })

  test('shows running state with shortened container id and host port mapping', () => {
    const out = formatStatus(
      baseReport({
        container: {
          kind: 'running',
          containerName: 'coder',
          imageTag: 'typeclaw-coder',
          containerId: 'sha256:abcdef0123456789',
          configuredImage: 'typeclaw-coder',
          hostPort: 51234,
          hostBindAddr: '0.0.0.0',
        },
      }),
    )

    expect(out).toContain('  state   running')
    expect(out).toContain('  id      abcdef012345')
    expect(out).toContain('  port    0.0.0.0:51234 -> container:51234')
  })

  test('shows stopped state with id but no port row', () => {
    const out = formatStatus(
      baseReport({
        container: {
          kind: 'stopped',
          containerName: 'coder',
          imageTag: 'typeclaw-coder',
          containerId: 'sha256:1234567890ab',
          configuredImage: 'typeclaw-coder',
        },
      }),
    )

    expect(out).toContain('  state   stopped')
    expect(out).toContain('  id      1234567890ab')
    expect(out).not.toContain('  port    ')
  })

  test('shows running with unknown port when docker port returned nothing', () => {
    const out = formatStatus(
      baseReport({
        container: {
          kind: 'running',
          containerName: 'coder',
          imageTag: 'typeclaw-coder',
          containerId: 'sha256:abc',
          configuredImage: 'typeclaw-coder',
          hostPort: null,
          hostBindAddr: null,
        },
      }),
    )

    expect(out).toContain('  port    unknown')
  })

  test('renders forwarded ports sorted ascending when hostd is registered', () => {
    const out = formatStatus(
      baseReport({
        hostd: { kind: 'registered', cwd: '/agents/coder', forwardedPorts: [3000, 5173, 8080] },
      }),
    )

    expect(out).toContain('Host daemon')
    expect(out).toContain('  state   registered')
    const portsBlock = out.slice(out.indexOf('Port forwarding'))
    const indices = [3000, 5173, 8080].map((p) => portsBlock.indexOf(`127.0.0.1:${p}`))
    expect(indices.every((i) => i >= 0)).toBe(true)
    expect(indices).toEqual([...indices].sort((a, b) => a - b))
  })

  test('renders empty forwarding hint when registered but no ports open', () => {
    const out = formatStatus(
      baseReport({
        hostd: { kind: 'registered', cwd: '/agents/coder', forwardedPorts: [] },
      }),
    )

    expect(out).toContain('Port forwarding')
    expect(out).toContain('no ports currently forwarded')
  })

  test('renders not-registered state with reason', () => {
    const out = formatStatus(
      baseReport({
        hostd: { kind: 'not-registered', reason: 'not registered: coder' },
      }),
    )

    expect(out).toContain('  state   not registered')
    expect(out).toContain('  reason  not registered: coder')
  })

  test('useColor=true wraps section headers with ANSI escapes', () => {
    const out = formatStatus(baseReport(), { useColor: true })
    const ESC = '\u001b'
    const BOLD = `${ESC}[1m`

    expect(out).toContain(`${BOLD}Container`)
    expect(out).toContain(`${BOLD}Host daemon`)
    expect(out).toContain(`${BOLD}Port forwarding`)
  })

  test('renders empty forwarding hint when daemon omits forwardedPorts (drift)', () => {
    const parsed = parseStatusResult({ containerName: 'coder', cwd: '/agents/coder' })
    expect(parsed).toEqual({ containerName: 'coder', cwd: '/agents/coder', forwardedPorts: [] })
    const out = formatStatus(
      baseReport({
        hostd: { kind: 'registered', cwd: parsed!.cwd, forwardedPorts: parsed!.forwardedPorts },
      }),
    )
    expect(out).toContain('no ports currently forwarded')
  })

  test('parser drops non-numeric forwardedPorts entries', () => {
    const parsed = parseStatusResult({
      containerName: 'coder',
      cwd: '/agents/coder',
      forwardedPorts: [3000, 'nope', null, 5173, Number.NaN, 8080],
    })
    expect(parsed?.forwardedPorts).toEqual([3000, 5173, 8080])
  })

  test('parser rejects payloads without a string cwd', () => {
    expect(parseStatusResult(null)).toBeNull()
    expect(parseStatusResult('hi')).toBeNull()
    expect(parseStatusResult({ containerName: 'coder' })).toBeNull()
    expect(parseStatusResult({ cwd: 42 })).toBeNull()
  })

  test('useColor=false produces output free of ANSI escape codes', () => {
    const out = formatStatus(
      baseReport({
        container: {
          kind: 'running',
          containerName: 'coder',
          imageTag: 'typeclaw-coder',
          containerId: 'sha256:abcdef012345',
          configuredImage: 'typeclaw-coder',
          hostPort: 51234,
          hostBindAddr: '127.0.0.1',
        },
        hostd: { kind: 'registered', cwd: '/x', forwardedPorts: [5173] },
      }),
    )

    expect(out).not.toContain('\u001b[')
  })
})
