import { describe, expect, test } from 'bun:test'

import { createLoadSkillTool, type LoadableSkill } from './load-skill'

const codeReview: LoadableSkill = {
  name: 'code-review',
  description: 'Review code: PRs, commits, files, modules.',
  content: '# code-review\nbody for code review',
}

const general: LoadableSkill = {
  name: 'general',
  description: 'Fallback for review targets without a specific domain.',
  content: '# general\nfallback body',
}

const noopCtx = {
  signal: undefined,
  sessionId: 'ses_test',
  agentDir: '/agent',
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}

describe('createLoadSkillTool', () => {
  test('returns content for a known skill name', async () => {
    const tool = createLoadSkillTool({ skills: [codeReview, general] })
    const result = await tool.execute({ name: 'code-review' }, noopCtx)
    expect(result.content).toEqual([{ type: 'text', text: codeReview.content }])
  })

  test('returns the fallback skill body when fallback name is requested', async () => {
    const tool = createLoadSkillTool({ skills: [codeReview, general] })
    const result = await tool.execute({ name: 'general' }, noopCtx)
    expect(result.content).toEqual([{ type: 'text', text: general.content }])
  })

  test('returns details with name and content byte count (for downstream budget accounting)', async () => {
    const tool = createLoadSkillTool({ skills: [codeReview] })
    const result = await tool.execute({ name: 'code-review' }, noopCtx)
    expect(result.details).toEqual({ name: 'code-review', contentBytes: codeReview.content.length })
  })

  test('parameter schema accepts only declared skill names (zod enum narrowed at construction)', () => {
    const tool = createLoadSkillTool({ skills: [codeReview, general] })
    expect(tool.parameters.safeParse({ name: 'code-review' }).success).toBe(true)
    expect(tool.parameters.safeParse({ name: 'general' }).success).toBe(true)
    expect(tool.parameters.safeParse({ name: 'plan-review' }).success).toBe(false)
    expect(tool.parameters.safeParse({}).success).toBe(false)
  })

  test('default description lists every skill name and description (model needs the menu BEFORE calling)', () => {
    const tool = createLoadSkillTool({ skills: [codeReview, general] })
    expect(tool.description).toContain('`code-review`')
    expect(tool.description).toContain(codeReview.description)
    expect(tool.description).toContain('`general`')
    expect(tool.description).toContain(general.description)
  })

  test('custom description override is used verbatim instead of the default', () => {
    const tool = createLoadSkillTool({
      skills: [codeReview],
      description: 'Custom framing for the load_skill tool.',
    })
    expect(tool.description).toBe('Custom framing for the load_skill tool.')
  })

  test('throws when skills list is empty (a load_skill tool with nothing to load is useless)', () => {
    expect(() => createLoadSkillTool({ skills: [] })).toThrow(/at least one entry/)
  })

  test('throws on duplicate skill names (would silently shadow on lookup)', () => {
    expect(() =>
      createLoadSkillTool({
        skills: [codeReview, { name: 'code-review', description: 'dup', content: 'dup body' }],
      }),
    ).toThrow(/duplicate skill name/)
  })

  test('throws on empty skill name (would produce an unselectable enum value)', () => {
    expect(() => createLoadSkillTool({ skills: [{ name: '', description: 'x', content: 'y' }] })).toThrow(
      /name must be non-empty/,
    )
  })

  test('skill descriptions appear in the tool description in the order the caller supplied (menu ordering is contract)', () => {
    const tool = createLoadSkillTool({ skills: [general, codeReview] })
    const codeIdx = tool.description.indexOf('`code-review`')
    const generalIdx = tool.description.indexOf('`general`')
    expect(generalIdx).toBeGreaterThan(-1)
    expect(codeIdx).toBeGreaterThan(generalIdx)
  })
})
