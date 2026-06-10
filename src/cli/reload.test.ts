import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test'

import { printReloadRecoveryHint } from './reload'

describe('printReloadRecoveryHint', () => {
  let consoleError: Mock<(...args: unknown[]) => void>

  beforeEach(() => {
    consoleError = spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleError.mockRestore()
  })

  test('prints the repair hint for container-local recovery', () => {
    printReloadRecoveryHint('connection ended')

    expect(consoleError).toHaveBeenCalledTimes(2)
    expect(consoleError.mock.calls[0]?.[0]).toContain('Recovered via container-local reload')
    expect(consoleError.mock.calls[0]?.[0]).toContain('connection ended')
    expect(consoleError.mock.calls[1]?.[0]).toContain('typeclaw restart --port 0')
  })

  test('prints nothing when host reload succeeds', () => {
    printReloadRecoveryHint(undefined)

    expect(consoleError).not.toHaveBeenCalled()
  })
})
