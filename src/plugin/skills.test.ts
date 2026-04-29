import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { materializeSkills } from './skills'

describe('materializeSkills', () => {
  test('writes one SKILL.md per skill into a fresh tmpdir; dispose removes it', async () => {
    const m = await materializeSkills([
      {
        pluginName: 'p1',
        localName: 'standup',
        skill: { description: 'how to standup', content: '# Standup\n\nSay yes.' },
      },
      {
        pluginName: 'p2',
        localName: 'note',
        skill: { description: 'how to note', content: '# Note\n\n…' },
      },
    ])

    expect(existsSync(m.dir)).toBe(true)
    expect(existsSync(join(m.dir, 'standup', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(m.dir, 'note', 'SKILL.md'))).toBe(true)
    const standup = readFileSync(join(m.dir, 'standup', 'SKILL.md'), 'utf8')
    expect(standup).toContain('description:')
    expect(standup).toContain('# Standup')

    await m.dispose()
    expect(existsSync(m.dir)).toBe(false)
  })

  test('throws on duplicate sanitized skill names', async () => {
    await expect(
      materializeSkills([
        {
          pluginName: 'p1',
          localName: 'a-name',
          skill: { description: 'd', content: 'x' },
        },
        {
          pluginName: 'p2',
          localName: 'a-name',
          skill: { description: 'd', content: 'x' },
        },
      ]),
    ).rejects.toThrow(/duplicate skill name/)
  })
})
