import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PluginSkill } from './types'

export type SkillEntry = { pluginName: string; localName: string; skill: PluginSkill }

export type MaterializedSkills = {
  dir: string
  dispose: () => Promise<void>
}

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-_]*$/

export async function materializeSkills(skills: SkillEntry[]): Promise<MaterializedSkills> {
  const root = await mkdtemp(join(tmpdir(), 'typeclaw-plugin-skills-'))

  try {
    const seen = new Set<string>()
    for (const entry of skills) {
      const sanitized = sanitizeSkillName(entry.localName)
      if (seen.has(sanitized)) {
        throw new Error(`plugin ${entry.pluginName}: duplicate skill name after sanitization: ${entry.localName}`)
      }
      seen.add(sanitized)

      const skillDir = join(root, sanitized)
      await mkdir(skillDir, { recursive: true })
      const body = renderSkillFile(entry.skill)
      await writeFile(join(skillDir, 'SKILL.md'), body, 'utf8')
    }
  } catch (err) {
    await rm(root, { recursive: true, force: true })
    throw err
  }

  return {
    dir: root,
    dispose: async () => {
      await rm(root, { recursive: true, force: true })
    },
  }
}

function sanitizeSkillName(name: string): string {
  if (SKILL_NAME_PATTERN.test(name)) return name
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '-')
}

function renderSkillFile(skill: PluginSkill): string {
  const fm = skill.frontmatter ?? {}
  const fmEntries = Object.entries({ ...fm, description: skill.description })
  if (fmEntries.length === 0) return skill.content
  const lines = ['---']
  for (const [key, value] of fmEntries) {
    lines.push(`${key}: ${JSON.stringify(value)}`)
  }
  lines.push('---', '')
  lines.push(skill.content)
  return lines.join('\n')
}
