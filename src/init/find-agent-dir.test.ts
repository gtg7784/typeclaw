import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { findAgentDir, isInitialized } from './find-agent-dir'

// The whole point of this module's existence is that the host CLI entry can
// import it WITHOUT dragging in the ~190ms init/config/container/plugin graph.
// A future contributor adding a heavy import here would silently undo the
// startup win while every behavioral test still passes — so guard the
// dependency direction explicitly.
describe('find-agent-dir dependency isolation', () => {
  test('imports nothing beyond node:fs and node:path', () => {
    const source = readFileSync(join(import.meta.dir, 'find-agent-dir.ts'), 'utf8')
    const importSpecifiers = [...source.matchAll(/^import .* from ['"]([^'"]+)['"]/gm)].map((m) => m[1])
    expect(importSpecifiers.sort()).toEqual(['node:fs', 'node:path'])
  })
})

describe('find-agent-dir re-exports are wired', () => {
  test('exposes findAgentDir and isInitialized as functions', () => {
    expect(typeof findAgentDir).toBe('function')
    expect(typeof isInitialized).toBe('function')
  })
})
