import { describe, expect, it } from 'bun:test'

import { extractQuickTunnelUrl } from './quick-url-parser'

describe('extractQuickTunnelUrl', () => {
  it('extracts trycloudflare.com URLs from captured cloudflared quick-tunnel stderr lines', async () => {
    const fixture = await Bun.file(new URL('./__fixtures__/cloudflared-quick-stderr.txt', import.meta.url)).text()
    const urls = fixture
      .split('\n')
      .map(extractQuickTunnelUrl)
      .filter((url): url is string => url !== null)

    expect(urls).toEqual(['https://wave-one-fixture.trycloudflare.com'])
  })

  it('returns null for non-quick-tunnel lines', () => {
    expect(
      extractQuickTunnelUrl('2026-01-01T00:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...'),
    ).toBeNull()
    expect(extractQuickTunnelUrl('visit wave-one-fixture.trycloudflare.com without a scheme')).toBeNull()
    expect(extractQuickTunnelUrl('https://example.com/path')).toBeNull()
  })

  it('extracts the first quick tunnel URL from a decorated line', () => {
    expect(
      extractQuickTunnelUrl(
        '2026-01-01T00:00:00Z INF |  https://abc-123.trycloudflare.com  | https://later.trycloudflare.com',
      ),
    ).toBe('https://abc-123.trycloudflare.com')
  })
})
