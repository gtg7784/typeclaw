import { describe, expect, test } from 'bun:test'

import { GUARD_SSRF, checkSsrfGuard, classifyIpAddress, classifyUrl } from './ssrf'

describe('SSRF classifier', () => {
  test('blocks AWS IMDS metadata endpoint', () => {
    expect(classifyUrl('http://169.254.169.254/latest/meta-data/iam/').blocked).toBe(true)
    expect(classifyUrl('http://169.254.169.254/').category).toBe('cloud_metadata')
  })

  test('blocks GCP metadata endpoint by hostname', () => {
    expect(classifyUrl('http://metadata.google.internal/computeMetadata/v1/').blocked).toBe(true)
  })

  test('blocks IPv4 loopback', () => {
    expect(classifyUrl('http://127.0.0.1/').blocked).toBe(true)
    expect(classifyUrl('http://127.0.0.1:8080/admin').blocked).toBe(true)
    expect(classifyUrl('http://127.99.99.99/').blocked).toBe(true)
  })

  test('blocks localhost hostname', () => {
    expect(classifyUrl('http://localhost/').blocked).toBe(true)
    expect(classifyUrl('https://LOCALHOST:3000/').blocked).toBe(true)
  })

  test('blocks RFC1918 private IPv4', () => {
    expect(classifyUrl('http://10.0.0.1/').blocked).toBe(true)
    expect(classifyUrl('http://10.255.255.255/').blocked).toBe(true)
    expect(classifyUrl('http://172.16.0.1/').blocked).toBe(true)
    expect(classifyUrl('http://172.31.255.1/').blocked).toBe(true)
    expect(classifyUrl('http://192.168.1.1/').blocked).toBe(true)
  })

  test('does not block 172.32.x.y (outside RFC1918)', () => {
    expect(classifyUrl('http://172.32.0.1/').blocked).toBe(false)
  })

  test('does not block 11.x.x.x (outside RFC1918)', () => {
    expect(classifyUrl('http://11.0.0.1/').blocked).toBe(false)
  })

  test('blocks 0.0.0.0', () => {
    expect(classifyUrl('http://0.0.0.0/').blocked).toBe(true)
  })

  test('blocks CGNAT 100.64.x.x', () => {
    expect(classifyUrl('http://100.64.0.1/').blocked).toBe(true)
    expect(classifyUrl('http://100.127.0.1/').blocked).toBe(true)
    expect(classifyUrl('http://100.63.0.1/').blocked).toBe(false)
    expect(classifyUrl('http://100.128.0.1/').blocked).toBe(false)
  })

  test('blocks the full 198.18.0.0/15 benchmarking range', () => {
    expect(classifyUrl('http://198.18.0.1/').blocked).toBe(true)
    expect(classifyUrl('http://198.19.42.7/internal').blocked).toBe(true)
    expect(classifyUrl('http://198.19.255.255/').blocked).toBe(true)
    expect(classifyUrl('http://198.17.255.255/').blocked).toBe(false)
    expect(classifyUrl('http://198.20.0.0/').blocked).toBe(false)
  })

  test('blocks decimal-encoded loopback (127.0.0.1 = 2130706433)', () => {
    expect(classifyUrl('http://2130706433/').blocked).toBe(true)
  })

  test('blocks hex-encoded loopback', () => {
    expect(classifyUrl('http://0x7f000001/').blocked).toBe(true)
  })

  test('blocks IPv6 loopback', () => {
    expect(classifyUrl('http://[::1]/').blocked).toBe(true)
  })

  test('blocks IPv6 link-local', () => {
    expect(classifyUrl('http://[fe80::1]/').blocked).toBe(true)
  })

  test('blocks IPv6 unique-local', () => {
    expect(classifyUrl('http://[fd12:3456:789a::1]/').blocked).toBe(true)
    expect(classifyUrl('http://[fc00::1]/').blocked).toBe(true)
  })

  test('blocks IPv4-mapped IPv6 loopback', () => {
    expect(classifyUrl('http://[::ffff:127.0.0.1]/').blocked).toBe(true)
  })

  test.each([
    '0:0:0:0:0:ffff:7f00:1',
    '0:0:0::ffff:7f00:1',
    '0000:0000:0000:0000:0000:ffff:7f00:0001',
    '::ffff:7f00:1',
    '::ffff:127.0.0.1',
  ])('blocks semantically equivalent IPv4-mapped IPv6 loopback %s', (address) => {
    expect(classifyIpAddress(address)).toEqual({
      blocked: true,
      category: 'loopback',
      reason: 'IPv4-mapped IPv6: IPv4 loopback (127.0.0.1)',
    })
  })

  test('allows an IPv4-mapped public address', () => {
    expect(classifyIpAddress('0:0:0:0:0:ffff:808:808')).toEqual({ blocked: false })
  })

  test('blocks .internal / .local / .corp / .home suffixes', () => {
    expect(classifyUrl('http://service.internal/').blocked).toBe(true)
    expect(classifyUrl('http://printer.local/').blocked).toBe(true)
    expect(classifyUrl('http://admin.corp/').blocked).toBe(true)
    expect(classifyUrl('http://nas.home/').blocked).toBe(true)
  })

  test('blocks file:// and other dangerous schemes', () => {
    expect(classifyUrl('file:///etc/passwd').blocked).toBe(true)
    expect(classifyUrl('gopher://127.0.0.1:25/').blocked).toBe(true)
    expect(classifyUrl('ftp://internal/').blocked).toBe(true)
    expect(classifyUrl('dict://127.0.0.1:11211/').blocked).toBe(true)
  })

  test('allows public URLs', () => {
    expect(classifyUrl('https://example.com/').blocked).toBe(false)
    expect(classifyUrl('https://api.github.com/').blocked).toBe(false)
    expect(classifyUrl('https://news.ycombinator.com/').blocked).toBe(false)
    expect(classifyUrl('http://1.1.1.1/').blocked).toBe(false)
    expect(classifyUrl('http://8.8.8.8/').blocked).toBe(false)
  })

  test('does not block bogus / unparseable URL (left to web_fetch tool to reject)', () => {
    expect(classifyUrl('not-a-url').blocked).toBe(false)
  })
})

describe('checkSsrfGuard', () => {
  test('blocks SSRF on web_fetch', () => {
    const result = checkSsrfGuard({ tool: 'web_fetch', args: { url: 'http://169.254.169.254/' } })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('cloud_metadata')
  })

  test('allows public URL', () => {
    expect(checkSsrfGuard({ tool: 'web_fetch', args: { url: 'https://example.com/' } })).toBeUndefined()
  })

  test('allows acknowledged SSRF', () => {
    const result = checkSsrfGuard({
      tool: 'web_fetch',
      args: { url: 'http://127.0.0.1:3000/dev', acknowledgeGuards: { ssrf: true } },
    })
    expect(result).toBeUndefined()
  })

  test('does not apply to non-web_fetch tools', () => {
    expect(checkSsrfGuard({ tool: 'bash', args: { url: 'http://127.0.0.1/' } })).toBeUndefined()
  })

  test('handles non-string url gracefully', () => {
    expect(checkSsrfGuard({ tool: 'web_fetch', args: { url: 42 } })).toBeUndefined()
    expect(checkSsrfGuard({ tool: 'web_fetch', args: {} })).toBeUndefined()
  })

  test('exposes guard name constant', () => {
    expect(GUARD_SSRF).toBe('ssrf')
  })
})
