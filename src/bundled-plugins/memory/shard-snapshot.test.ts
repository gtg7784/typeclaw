import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { captureShardSnapshot, restoreShardSnapshot } from './shard-snapshot'

describe('captureShardSnapshot', () => {
  test('empty dir returns empty Map', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-snapshot-'))
    try {
      const snap = await captureShardSnapshot(dir)
      expect(snap.size).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('missing dir (ENOENT) returns empty Map', async () => {
    const snap = await captureShardSnapshot('/nonexistent/path/that/does/not/exist')
    expect(snap.size).toBe(0)
  })

  test('captures flat .md files sorted by absolute path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-snapshot-'))
    try {
      await writeFile(join(dir, 'b.md'), Buffer.from('bbb'))
      await writeFile(join(dir, 'a.md'), Buffer.from('aaa'))
      await writeFile(join(dir, 'c.txt'), Buffer.from('ccc'))

      const snap = await captureShardSnapshot(dir)
      const keys = [...snap.keys()]

      expect(snap.size).toBe(2)
      expect(keys[0]!.endsWith('a.md')).toBe(true)
      expect(keys[1]!.endsWith('b.md')).toBe(true)
      expect(snap.get(keys[0]!)).toEqual(Buffer.from('aaa'))
      expect(snap.get(keys[1]!)).toEqual(Buffer.from('bbb'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('ignores nested .md files (flat only)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-snapshot-'))
    try {
      await writeFile(join(dir, 'top.md'), Buffer.from('top'))
      await mkdir(join(dir, 'sub'))
      await writeFile(join(dir, 'sub', 'nested.md'), Buffer.from('nested'))

      const snap = await captureShardSnapshot(dir)
      expect(snap.size).toBe(1)
      expect([...snap.values()][0]).toEqual(Buffer.from('top'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('restoreShardSnapshot', () => {
  test('round-trip: capture, mutate, restore', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-snapshot-'))
    try {
      await writeFile(join(dir, 'one.md'), Buffer.from('original-one'))
      await writeFile(join(dir, 'two.md'), Buffer.from('original-two'))
      await writeFile(join(dir, 'three.md'), Buffer.from('original-three'))

      const snap = await captureShardSnapshot(dir)
      expect(snap.size).toBe(3)

      await writeFile(join(dir, 'one.md'), Buffer.from('garbage'))
      await writeFile(join(dir, 'two.md'), Buffer.from('garbage'))
      await writeFile(join(dir, 'three.md'), Buffer.from('garbage'))

      await restoreShardSnapshot(snap, dir)

      expect(await readFile(join(dir, 'one.md'))).toEqual(Buffer.from('original-one'))
      expect(await readFile(join(dir, 'two.md'))).toEqual(Buffer.from('original-two'))
      expect(await readFile(join(dir, 'three.md'))).toEqual(Buffer.from('original-three'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('deletes new .md files added between capture and restore', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-snapshot-'))
    try {
      await writeFile(join(dir, 'orig-a.md'), Buffer.from('a'))
      await writeFile(join(dir, 'orig-b.md'), Buffer.from('b'))

      const snap = await captureShardSnapshot(dir)
      expect(snap.size).toBe(2)

      await writeFile(join(dir, 'rogue.md'), Buffer.from('rogue'))

      await restoreShardSnapshot(snap, dir)

      const remaining = await readdir(dir)
      expect(remaining.sort()).toEqual(['orig-a.md', 'orig-b.md'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('restore against empty snapshot deletes everything in topicsDir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-snapshot-'))
    try {
      const emptySnap = await captureShardSnapshot(dir)
      expect(emptySnap.size).toBe(0)

      await writeFile(join(dir, 'orphan.md'), Buffer.from('orphan'))

      await restoreShardSnapshot(emptySnap, dir)

      const remaining = await readdir(dir)
      expect(remaining).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('does not touch nested .md files during restore', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-snapshot-'))
    try {
      await writeFile(join(dir, 'top.md'), Buffer.from('top'))
      await mkdir(join(dir, 'sub'), { recursive: true })
      await writeFile(join(dir, 'sub', 'nested.md'), Buffer.from('nested'))

      const snap = await captureShardSnapshot(dir)
      await restoreShardSnapshot(snap, dir)

      expect(await readFile(join(dir, 'top.md'))).toEqual(Buffer.from('top'))
      expect(await readFile(join(dir, 'sub', 'nested.md'))).toEqual(Buffer.from('nested'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
