import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createOverrideResourceLoader, createResourceLoader, getBundledSkillsDir } from './index'
import { DEFAULT_SYSTEM_PROMPT } from './system-prompt'

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-agent-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

describe('createResourceLoader', () => {
  test('starts the system prompt with the typeclaw default instead of pi default', async () => {
    // when
    const loader = await createResourceLoader({ agentDir })

    // then
    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt.startsWith(DEFAULT_SYSTEM_PROMPT)).toBe(true)
  })

  test('does not append SYSTEM.md files discovered by pi defaults', async () => {
    // Pi's DefaultResourceLoader auto-appends ~/.pi/agent/APPEND_SYSTEM.md and
    // .pi/APPEND_SYSTEM.md. Typeclaw owns the whole system prompt, so nothing
    // from pi's discovery should leak in.

    // when
    const loader = await createResourceLoader({ agentDir })

    // then
    expect(loader.getAppendSystemPrompt()).toEqual([])
  })

  test('injects IDENTITY.md and SOUL.md contents into the system prompt', async () => {
    // given
    await writeFile(join(agentDir, 'IDENTITY.md'), 'I am Tester.')
    await writeFile(join(agentDir, 'SOUL.md'), 'Pedantic and kind.')

    // when
    const loader = await createResourceLoader({ agentDir })

    // then
    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).toContain('I am Tester.')
    expect(prompt).toContain('Pedantic and kind.')
  })

  test('signals missing identity files so the model can see they should exist', async () => {
    // when (no files written)
    const loader = await createResourceLoader({ agentDir })

    // then
    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).toContain('[MISSING]')
    expect(prompt).toContain('IDENTITY.md')
    expect(prompt).toContain('SOUL.md')
  })

  test('does NOT inject MEMORY.md or memory/ stream contents (owned by the bundled memory plugin via session.prompt hook)', async () => {
    await writeFile(join(agentDir, 'MEMORY.md'), 'Neo prefers terse replies.')
    await mkdir(join(agentDir, 'memory'))
    await writeFile(join(agentDir, 'memory', '2026-04-27.md'), 'tuesday-fragment-marker')

    const loader = await createResourceLoader({ agentDir })

    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).not.toContain('Neo prefers terse replies.')
    expect(prompt).not.toContain('tuesday-fragment-marker')
    expect(prompt).not.toContain('## memory/2026-04-27.md')
  })

  test('exposes the typeclaw-cron bundled skill to the agent', async () => {
    const loader = await createResourceLoader({ agentDir })

    const { skills } = loader.getSkills()
    const cronSkill = skills.find((s) => s.name === 'typeclaw-cron')
    expect(cronSkill).toBeDefined()
    expect(cronSkill?.description.length).toBeGreaterThan(0)
  })

  test('exposes the typeclaw-config bundled skill to the agent', async () => {
    const loader = await createResourceLoader({ agentDir })

    const { skills } = loader.getSkills()
    const configSkill = skills.find((s) => s.name === 'typeclaw-config')
    expect(configSkill).toBeDefined()
    expect(configSkill?.description.length).toBeGreaterThan(0)
  })

  test('exposes the agent-browser bundled skill to the agent', async () => {
    const loader = await createResourceLoader({ agentDir })

    const { skills } = loader.getSkills()
    const browserSkill = skills.find((s) => s.name === 'agent-browser')
    expect(browserSkill).toBeDefined()
    expect(browserSkill?.description.length).toBeGreaterThan(0)
  })

  test('exposes user-installed skills under <agentDir>/.agents/skills/ to the agent', async () => {
    // given
    await mkdir(join(agentDir, '.agents', 'skills', 'user-tool'), { recursive: true })
    await writeFile(
      join(agentDir, '.agents', 'skills', 'user-tool', 'SKILL.md'),
      '---\nname: user-tool\ndescription: A user-installed skill\n---\n\nbody',
    )

    // when
    const loader = await createResourceLoader({ agentDir })

    // then
    const { skills } = loader.getSkills()
    const userSkill = skills.find((s) => s.name === 'user-tool')
    expect(userSkill).toBeDefined()
    expect(userSkill?.description).toBe('A user-installed skill')
  })

  test('does not throw when <agentDir>/.agents/skills/ does not exist', async () => {
    // when / then
    const loader = await createResourceLoader({ agentDir })
    expect(loader.getSkills().skills).toBeDefined()
  })
})

describe('createOverrideResourceLoader', () => {
  test('uses the override string verbatim as the system prompt', async () => {
    // when
    const loader = await createOverrideResourceLoader('SUBAGENT PROMPT')

    // then
    expect(loader.getSystemPrompt()).toBe('SUBAGENT PROMPT')
  })

  test('does not include the typeclaw default system prompt', async () => {
    // when
    const loader = await createOverrideResourceLoader('SUBAGENT PROMPT')

    // then
    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).not.toContain(DEFAULT_SYSTEM_PROMPT)
  })

  test('does not append SYSTEM.md files discovered by pi defaults', async () => {
    // when
    const loader = await createOverrideResourceLoader('SUBAGENT PROMPT')

    // then
    expect(loader.getAppendSystemPrompt()).toEqual([])
  })
})

describe('getBundledSkillsDir', () => {
  test.each([['typeclaw-cron'], ['typeclaw-config'], ['agent-browser']])(
    'points at a directory containing %s/SKILL.md',
    (skill) => {
      const dir = getBundledSkillsDir()
      expect(existsSync(join(dir, skill, 'SKILL.md'))).toBe(true)
    },
  )

  test.each([['typeclaw-cron'], ['typeclaw-config'], ['agent-browser']])(
    '%s SKILL.md has YAML frontmatter with name and description',
    async (skill) => {
      const path = join(getBundledSkillsDir(), skill, 'SKILL.md')
      const raw = await readFile(path, 'utf8')

      expect(raw.startsWith('---\n')).toBe(true)
      const frontmatterEnd = raw.indexOf('\n---\n', 4)
      expect(frontmatterEnd).toBeGreaterThan(0)
      const frontmatter = raw.slice(4, frontmatterEnd)
      expect(frontmatter).toMatch(new RegExp(`^name:\\s*${skill}\\s*$`, 'm'))
      expect(frontmatter).toMatch(/^description:\s*\S/m)
    },
  )
})
