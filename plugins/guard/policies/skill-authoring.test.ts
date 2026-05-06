import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { checkSkillAuthoringDecision } from './skill-authoring'

describe('skill authoring guard policy', () => {
  test('allows valid skill writes and blocks invalid frontmatter', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-skill-guard-'))
    await mkdir(path.join(agentDir, 'memory', 'skills'), { recursive: true })

    const allowed = await checkSkillAuthoringDecision({
      tool: 'write',
      agentDir,
      args: { path: 'memory/skills/release-checklist/SKILL.md', content: skillFile('release-checklist') },
    })
    const blocked = await checkSkillAuthoringDecision({
      tool: 'write',
      agentDir,
      args: { path: 'memory/skills/release-checklist/SKILL.md', content: skillFile('other-name') },
    })

    expect(allowed).toEqual({ allow: true })
    expect(blocked).toEqual({
      block: true,
      reason: expect.stringContaining('frontmatter name must match'),
    })
  })

  test('does not treat dev-stage bundled skill paths as runtime-authorable skills', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-skill-guard-'))
    await mkdir(path.join(agentDir, 'src', 'skills'), { recursive: true })

    const result = await checkSkillAuthoringDecision({
      tool: 'write',
      agentDir,
      args: { path: 'src/skills/typeclaw-example/SKILL.md', content: skillFile('typeclaw-example') },
    })

    expect(result).toBeUndefined()
  })

  test('validates the final content produced by edit calls', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-skill-guard-'))
    const skillPath = path.join(agentDir, 'memory', 'skills', 'release-checklist', 'SKILL.md')
    await mkdir(path.dirname(skillPath), { recursive: true })
    await writeFile(skillPath, skillFile('release-checklist', 'Old description'))

    const allowed = await checkSkillAuthoringDecision({
      tool: 'edit',
      agentDir,
      args: {
        path: 'memory/skills/release-checklist/SKILL.md',
        edits: [{ oldText: 'Old description', newText: 'New description' }],
      },
    })
    const blocked = await checkSkillAuthoringDecision({
      tool: 'edit',
      agentDir,
      args: {
        path: 'memory/skills/release-checklist/SKILL.md',
        edits: [{ oldText: 'name: release-checklist', newText: 'name: other-name' }],
      },
    })

    expect(allowed).toEqual({ allow: true })
    expect(blocked).toEqual({
      block: true,
      reason: expect.stringContaining('frontmatter name must match'),
    })
  })
})

function skillFile(name: string, description = 'Use when shipping a release.'): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`
}
