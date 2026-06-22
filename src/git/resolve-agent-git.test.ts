import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveAgentGit } from './resolve-agent-git'

function tempAgent(): string {
  return mkdtempSync(join(tmpdir(), 'typeclaw-agent-git-'))
}

describe('resolveAgentGit', () => {
  test('returns dotgit with empty args when only .git exists', () => {
    const dir = tempAgent()
    try {
      mkdirSync(join(dir, '.git'))
      expect(resolveAgentGit(dir)).toEqual({ kind: 'dotgit', gitArgs: [] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('returns gitstore args when only .gitstore exists', () => {
    const dir = tempAgent()
    try {
      mkdirSync(join(dir, '.gitstore'))
      expect(resolveAgentGit(dir)).toEqual({
        kind: 'gitstore',
        gitArgs: ['--git-dir', join(dir, '.gitstore'), '--work-tree', dir],
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('returns null when neither git layout exists', () => {
    const dir = tempAgent()
    try {
      expect(resolveAgentGit(dir)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('prefers .git when both layouts exist', () => {
    const dir = tempAgent()
    try {
      mkdirSync(join(dir, '.git'))
      mkdirSync(join(dir, '.gitstore'))
      expect(resolveAgentGit(dir)).toEqual({ kind: 'dotgit', gitArgs: [] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
