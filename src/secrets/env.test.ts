import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { removeKeyFromEnvText, stripEnvKey } from './env'

describe('removeKeyFromEnvText', () => {
  test('removes the matching key and leaves the trailing newline intact', () => {
    const input = 'FIREWORKS_API_KEY=fw_test\nOPENAI_API_KEY=sk-keep\n'
    expect(removeKeyFromEnvText(input, 'FIREWORKS_API_KEY')).toBe('OPENAI_API_KEY=sk-keep\n')
  })

  test('returns the input unchanged when the key is absent', () => {
    const input = 'OPENAI_API_KEY=sk-keep\n'
    expect(removeKeyFromEnvText(input, 'FIREWORKS_API_KEY')).toBe(input)
  })

  test('preserves blank lines and comments around the removed key', () => {
    const input = '# header comment\n\nFIREWORKS_API_KEY=fw\n\n# trailing comment\nOTHER=value\n'
    expect(removeKeyFromEnvText(input, 'FIREWORKS_API_KEY')).toBe(
      '# header comment\n\n\n# trailing comment\nOTHER=value\n',
    )
  })

  test('removes every line that assigns the key when duplicates exist', () => {
    const input = 'FIREWORKS_API_KEY=fw_old\nOTHER=value\nFIREWORKS_API_KEY=fw_new\n'
    expect(removeKeyFromEnvText(input, 'FIREWORKS_API_KEY')).toBe('OTHER=value\n')
  })

  test('does not strip keys whose name starts with the target (prefix safety)', () => {
    const input = 'FIREWORKS_API_KEY=fw\nFIREWORKS_API_KEY_BACKUP=fw_bak\n'
    expect(removeKeyFromEnvText(input, 'FIREWORKS_API_KEY')).toBe('FIREWORKS_API_KEY_BACKUP=fw_bak\n')
  })

  test('tolerates surrounding whitespace in the key declaration', () => {
    const input = '  FIREWORKS_API_KEY=fw  \nOTHER=value\n'
    expect(removeKeyFromEnvText(input, 'FIREWORKS_API_KEY')).toBe('OTHER=value\n')
  })

  test('does not treat commented-out assignments as matching', () => {
    const input = '# FIREWORKS_API_KEY=fw_disabled\nFIREWORKS_API_KEY=fw_real\n'
    expect(removeKeyFromEnvText(input, 'FIREWORKS_API_KEY')).toBe('# FIREWORKS_API_KEY=fw_disabled\n')
  })

  test('returns empty string when the only content was the target key', () => {
    expect(removeKeyFromEnvText('FIREWORKS_API_KEY=fw\n', 'FIREWORKS_API_KEY')).toBe('')
  })
})

describe('stripEnvKey', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'typeclaw-strip-env-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('rewrites the file with the matching key removed', () => {
    const path = join(dir, '.env')
    writeFileSync(path, 'FIREWORKS_API_KEY=fw_test\nOPENAI_API_KEY=sk-keep\n')

    stripEnvKey(path, 'FIREWORKS_API_KEY')

    expect(readFileSync(path, 'utf8')).toBe('OPENAI_API_KEY=sk-keep\n')
  })

  test('is a silent no-op when the file does not exist', () => {
    const path = join(dir, '.env')

    expect(() => stripEnvKey(path, 'FIREWORKS_API_KEY')).not.toThrow()
  })

  test('does not rewrite the file when the key is absent', () => {
    const path = join(dir, '.env')
    const content = 'OPENAI_API_KEY=sk-keep\n'
    writeFileSync(path, content)

    stripEnvKey(path, 'FIREWORKS_API_KEY')

    expect(readFileSync(path, 'utf8')).toBe(content)
  })
})
