import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const COMMITTER_FILES = [
  'src/bundled-plugins/backup/runner.ts',
  'src/bundled-plugins/backup/index.ts',
  'src/bundled-plugins/memory/dreaming.ts',
  'src/git/system-commit.ts',
  'src/git/reconcile-ignored.ts',
  'src/doctor/commit.ts',
  'src/agent/git-nudge.ts',
  'src/bundled-plugins/guard/policies/uncommitted-changes.ts',
  'src/dreams/git.ts',
] as const

describe('committer git layout resolution', () => {
  test('retrofitted committers import resolveAgentGit', async () => {
    for (const file of COMMITTER_FILES) {
      const source = await readFile(join(process.cwd(), file), 'utf8')
      expect(source, file).toContain('resolveAgentGit')
    }
  })
})
