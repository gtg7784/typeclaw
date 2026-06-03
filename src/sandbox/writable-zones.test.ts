import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveWritableZones } from './writable-zones'

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-writable-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

describe('resolveWritableZones', () => {
  test('includes only the allowed dirs that actually exist', async () => {
    await mkdir(join(agentDir, 'workspace'))
    await mkdir(join(agentDir, 'public'))

    const { dirs } = await resolveWritableZones(agentDir)

    expect(dirs).toEqual([join(agentDir, 'workspace'), join(agentDir, 'public')])
  })

  test('includes nested .agents/skills when present', async () => {
    await mkdir(join(agentDir, '.agents', 'skills'), { recursive: true })

    const { dirs } = await resolveWritableZones(agentDir)

    expect(dirs).toContain(join(agentDir, '.agents/skills'))
  })

  test('includes only the allowed root files that exist', async () => {
    await writeFile(join(agentDir, 'AGENTS.md'), '# agents')
    await writeFile(join(agentDir, 'typeclaw.json'), '{}')

    const { files } = await resolveWritableZones(agentDir)

    expect(files).toEqual([join(agentDir, 'AGENTS.md'), join(agentDir, 'typeclaw.json')])
  })

  test('rejects a zone dir that is a symlink (RW bind would follow it outside)', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'typeclaw-outside-'))
    try {
      await symlink(outside, join(agentDir, 'workspace'))

      const { dirs } = await resolveWritableZones(agentDir)

      expect(dirs).not.toContain(join(agentDir, 'workspace'))
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('rejects a root file that is a symlink', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'typeclaw-outside-'))
    try {
      const target = join(outside, 'real.json')
      await writeFile(target, '{}')
      await symlink(target, join(agentDir, 'typeclaw.json'))

      const { files } = await resolveWritableZones(agentDir)

      expect(files).not.toContain(join(agentDir, 'typeclaw.json'))
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('does not treat a same-named file as a writable dir (or vice versa)', async () => {
    await writeFile(join(agentDir, 'workspace'), 'not a dir')
    await mkdir(join(agentDir, 'AGENTS.md'))

    const { dirs, files } = await resolveWritableZones(agentDir)

    expect(dirs).not.toContain(join(agentDir, 'workspace'))
    expect(files).not.toContain(join(agentDir, 'AGENTS.md'))
  })

  test('returns empty lists for a bare agent dir', async () => {
    const { dirs, files } = await resolveWritableZones(agentDir)

    expect(dirs).toEqual([])
    expect(files).toEqual([])
  })
})
