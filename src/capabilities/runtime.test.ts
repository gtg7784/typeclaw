import { describe, expect, test } from 'bun:test'

import { createRuntimeCapabilities } from './runtime'

describe('createRuntimeCapabilities', () => {
  test('provides a secrets provider when the hostd triple is present', () => {
    const caps = createRuntimeCapabilities({
      TYPECLAW_HOSTD_URL: 'http://host.docker.internal:8974',
      TYPECLAW_HOSTD_TOKEN: 'restart-token',
      TYPECLAW_CONTAINER_NAME: 'agent',
    })
    expect(caps.secrets).not.toBeNull()
  })

  test('degrades secrets to null when the hostd triple is absent', () => {
    const caps = createRuntimeCapabilities({})
    expect(caps.secrets).toBeNull()
  })

  test('degrades secrets to null when the triple is only partially set', () => {
    const caps = createRuntimeCapabilities({ TYPECLAW_HOSTD_URL: 'http://host.docker.internal:8974' })
    expect(caps.secrets).toBeNull()
  })
})
