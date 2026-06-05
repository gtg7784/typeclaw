import { describe, expect, test } from 'bun:test'

import {
  PLANNER_DEFAULT_PLAN_DIR,
  PLANNER_SKILLS,
  PLANNER_SYSTEM_PROMPT,
  createPlannerSubagent,
  plannerPayloadSchema,
} from './planner'
import { GENERAL_PLAN_SKILL } from './skills/general'
import { PROJECT_PLAN_SKILL } from './skills/project'

describe('planner subagent — load-bearing prompt phrases', () => {
  test.each(
    [
      'WRITE CONTRACT',
      'STRICTLY PROHIBITED',
      'parallel',
      '<plan-summary>',
      '<path>',
      '<summary>',
      '<verdict>',
      '<questions>',
      'ready',
      'needs-input',
      'infeasible',
    ].map((phrase) => [phrase] as const),
  )('prompt contains %s', (phrase) => {
    const haystack = PLANNER_SYSTEM_PROMPT.toLowerCase()
    expect(haystack).toContain(phrase.toLowerCase())
  })

  test('prompt forbids posting to channels (parent owns communication, planner only produces)', () => {
    const lower = PLANNER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('posting to github')
    expect(lower).toContain('parent owns all communication')
  })

  test('prompt forbids bash for write/mutating operations', () => {
    expect(PLANNER_SYSTEM_PROMPT).toContain('mkdir')
    expect(PLANNER_SYSTEM_PROMPT).toContain('rm')
    expect(PLANNER_SYSTEM_PROMPT).toContain('git add')
    expect(PLANNER_SYSTEM_PROMPT).toContain('git commit')
    expect(PLANNER_SYSTEM_PROMPT).toContain('git push')
  })

  test('prompt constrains the planner to writing exactly ONE file (write, not edit)', () => {
    expect(PLANNER_SYSTEM_PROMPT).toContain('ONE ARTIFACT')
    expect(PLANNER_SYSTEM_PROMPT).toContain('EXACTLY ONE file')
    const lower = PLANNER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('you have `write`, not `edit`')
  })

  test('prompt names the dedicated tools by their exact runtime names', () => {
    expect(PLANNER_SYSTEM_PROMPT).toContain('`read`')
    expect(PLANNER_SYSTEM_PROMPT).toContain('`grep`')
    expect(PLANNER_SYSTEM_PROMPT).toContain('`find`')
    expect(PLANNER_SYSTEM_PROMPT).toContain('`ls`')
    expect(PLANNER_SYSTEM_PROMPT).toContain('`bash`')
    expect(PLANNER_SYSTEM_PROMPT).toContain('`web_search`')
    expect(PLANNER_SYSTEM_PROMPT).toContain('`web_fetch`')
    expect(PLANNER_SYSTEM_PROMPT).toContain('`write`')
    expect(PLANNER_SYSTEM_PROMPT).toContain('`load_skill`')
  })

  test('prompt is domain-neutral: does NOT inline coding-specific workflow in the base (drift guard)', () => {
    // The whole point of the skill refactor: coding-specific planning craft
    // (gh/git workflow, the bun verification command) lives in a future
    // `engineering` skill, never in the base prompt. If an edit pulls that in,
    // the planner stops being usable for trip/launch/research planning and this
    // test catches it.
    expect(PLANNER_SYSTEM_PROMPT).not.toContain('gh pr')
    expect(PLANNER_SYSTEM_PROMPT).not.toContain('git diff')
    expect(PLANNER_SYSTEM_PROMPT).not.toContain('bun run')
    expect(PLANNER_SYSTEM_PROMPT).not.toContain('typecheck')
  })

  test('prompt frames the goal as cross-domain (trip/launch/migration, not just code)', () => {
    const lower = PLANNER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('trip')
    expect(lower).toContain('launch')
    expect(lower).toContain('migrate')
  })

  test('prompt instructs the planner to load a skill BEFORE forming the plan (architectural intent)', () => {
    const lower = PLANNER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('load_skill')
    expect(lower).toContain('identify the goal')
    expect(lower).toContain('domain')
    expect(PLANNER_SYSTEM_PROMPT).toContain('first thing you do')
  })

  test('prompt encodes the fail-fast interview handoff (subagent cannot interview; parent owns the channel)', () => {
    const lower = PLANNER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('fail fast')
    expect(lower).toContain('do not plan around the void')
    expect(lower).toContain('the parent will interview')
    expect(lower).toContain('cannot talk to the user')
  })

  test('prompt distinguishes research-resolvable from user-only inputs (no lazy question dumping)', () => {
    const lower = PLANNER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('research-resolvable')
    expect(lower).toContain('user-only')
    expect(lower).toContain('cannot research a preference')
  })

  test('prompt resolves the output path BEFORE planning and warns about the guest workspace-write block', () => {
    const lower = PLANNER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('resolving the output path')
    expect(lower).toContain('before you plan')
    expect(lower).toContain('denied by permissions')
    expect(lower).toContain('public/')
  })

  test('prompt names the structured plan-summary shape explicitly (so the parent can parse path + verdict)', () => {
    expect(PLANNER_SYSTEM_PROMPT).toContain('<question id=')
    expect(PLANNER_SYSTEM_PROMPT).toContain('blocking="true"')
    expect(PLANNER_SYSTEM_PROMPT).toContain('## Open Questions')
  })

  test('prompt frames delegation as context-saving (deep model offloads bulk research to cheaper workers)', () => {
    const lower = PLANNER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('spawn_subagent')
    expect(lower).toContain('cheaper')
    // The judgment stays with the planner — delegation gathers, never decides.
    expect(lower).toContain('never delegate the judgment')
  })

  test('prompt still forbids side effects through a delegate (no laundering write access via a subagent)', () => {
    const lower = PLANNER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('a subagent you spawn cannot do for you')
  })

  test('prompt forbids generic planning noise (drift guard: the whole point of a deep-model planner)', () => {
    const lower = PLANNER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('no generic planning noise')
  })

  test('prompt frames the role as deep-model analysis (so token-spend is justified)', () => {
    const lower = PLANNER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('quality, not speed')
    expect(lower).toContain('spend tokens')
  })

  test('prompt handles the empty-goal case as needs-input with one blocking question (no file)', () => {
    const lower = PLANNER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('cannot identify any usable goal')
    expect(PLANNER_SYSTEM_PROMPT).toContain('What would you like me to plan?')
  })
})

describe('planner subagent declaration', () => {
  test('is registered as visibility=public so spawn_subagent exposes it', () => {
    const sub = createPlannerSubagent()
    expect(sub.visibility).toBe('public')
  })

  test('uses the deep model profile (quality over speed for planning)', () => {
    const sub = createPlannerSubagent()
    expect(sub.profile).toBe('deep')
  })

  test('does NOT require a specific permission (member with generic subagent.spawn can spawn it)', () => {
    const sub = createPlannerSubagent()
    expect(sub.requiresSpecificPermission ?? false).toBe(false)
  })

  test('declares canSpawnSubagents=true (deep-model planner offloads bulk research to cheaper workers)', () => {
    const sub = createPlannerSubagent()
    expect(sub.canSpawnSubagents).toBe(true)
  })

  test('tools include write (one plan artifact) plus the read-only set, but NOT edit', () => {
    const sub = createPlannerSubagent()
    const toolNames = (sub.tools ?? []).map((t) => t.__builtinTool).sort()
    expect(toolNames).toEqual(['bash', 'find', 'grep', 'ls', 'read', 'web_fetch', 'web_search', 'write'])
    expect(toolNames).toContain('write')
    expect(toolNames).not.toContain('edit')
  })

  test('customTools contains exactly one tool: load_skill (the runtime-skill-loader)', () => {
    const sub = createPlannerSubagent()
    expect(sub.customTools).toBeDefined()
    expect(sub.customTools).toHaveLength(1)
    const loadSkill = sub.customTools?.[0]
    if (loadSkill === undefined) throw new Error('load_skill tool missing')
    expect(loadSkill.description).toContain('`project`')
    expect(loadSkill.description).toContain('`general`')
  })

  test('load_skill parameter schema accepts the shipped skill names and rejects unknown ones', () => {
    const sub = createPlannerSubagent()
    const loadSkill = sub.customTools?.[0]
    if (loadSkill === undefined) throw new Error('load_skill tool missing')
    expect(loadSkill.parameters.safeParse({ name: 'project' }).success).toBe(true)
    expect(loadSkill.parameters.safeParse({ name: 'general' }).success).toBe(true)
    expect(loadSkill.parameters.safeParse({ name: 'engineering' }).success).toBe(false)
    expect(loadSkill.parameters.safeParse({ name: '' }).success).toBe(false)
  })

  test('PLANNER_SKILLS includes project and general (initial neutral ship set)', () => {
    const names = PLANNER_SKILLS.map((s) => s.name)
    expect(names).toContain('project')
    expect(names).toContain('general')
  })

  test('declares a tool-result budget so a runaway subagent cannot exhaust parent context', () => {
    const sub = createPlannerSubagent()
    expect(sub.toolResultBudget).toBeDefined()
    expect(sub.toolResultBudget?.maxTotalBytes).toBeGreaterThan(0)
  })

  test('tool-result budget covers write and load_skill (the plan body and loaded skills count against the cap)', () => {
    const sub = createPlannerSubagent()
    expect(sub.toolResultBudget?.toolNames).toContain('write')
    expect(sub.toolResultBudget?.toolNames).toContain('load_skill')
  })

  test('budget sits between explorer (256KB) and operator (1MB) — read-mostly deep analysis, bounded', () => {
    const sub = createPlannerSubagent()
    const budget = sub.toolResultBudget?.maxTotalBytes ?? 0
    expect(budget).toBeGreaterThan(256_000)
    expect(budget).toBeLessThan(1_000_000)
  })

  test('declares a spawn timeout so a stalled plan fails the parent loudly instead of hanging forever', () => {
    const sub = createPlannerSubagent()
    expect(sub.timeoutMs).toBeGreaterThan(0)
  })

  test('spawn timeout is generous enough for a deep-model plan but not unbounded', () => {
    const sub = createPlannerSubagent()
    const timeout = sub.timeoutMs ?? 0
    expect(timeout).toBeGreaterThanOrEqual(60_000)
    expect(timeout).toBeLessThanOrEqual(1_800_000)
  })

  test('inFlightKey returns distinct values for distinct requestId payloads (parallel spawns must not coalesce)', () => {
    const sub = createPlannerSubagent()
    const k1 = sub.inFlightKey?.({ requestId: 'bg_a' })
    const k2 = sub.inFlightKey?.({ requestId: 'bg_b' })
    expect(k1).toBe('bg_a')
    expect(k2).toBe('bg_b')
    expect(k1).not.toBe(k2)
  })

  test('inFlightKey falls back to a random value when no requestId is provided (no accidental coalescing)', () => {
    const sub = createPlannerSubagent()
    const k1 = sub.inFlightKey?.({})
    const k2 = sub.inFlightKey?.({})
    expect(k1).not.toBe(k2)
  })
})

describe('plannerPayloadSchema', () => {
  test('accepts a full payload with requestId + prompt + description + outputPath', () => {
    const result = plannerPayloadSchema.safeParse({
      requestId: 'bg_t1',
      prompt: 'plan a 7-day Tokyo trip',
      description: 'trip plan',
      outputPath: 'workspace/plans/tokyo.md',
    })
    expect(result.success).toBe(true)
  })

  test('accepts a payload with only requestId (spawn-tool minimum)', () => {
    const result = plannerPayloadSchema.safeParse({ requestId: 'bg_t1' })
    expect(result.success).toBe(true)
  })

  test('accepts a public/ outputPath (the safe zone for low-trust callers)', () => {
    const result = plannerPayloadSchema.safeParse({ outputPath: 'public/plans/trip.md' })
    expect(result.success).toBe(true)
  })

  test('rejects an absolute outputPath (must stay inside the agent folder)', () => {
    const result = plannerPayloadSchema.safeParse({ outputPath: '/etc/passwd' })
    expect(result.success).toBe(false)
  })

  test('rejects a traversal outputPath (no .. escape out of the agent folder)', () => {
    expect(plannerPayloadSchema.safeParse({ outputPath: '../../etc/passwd' }).success).toBe(false)
    expect(plannerPayloadSchema.safeParse({ outputPath: 'workspace/../../secrets.json' }).success).toBe(false)
  })

  test('passes through unknown fields (forward-compat with future spawn-tool params, matches reviewer)', () => {
    const result = plannerPayloadSchema.safeParse({ requestId: 'bg_t1', priorDraftPath: 'workspace/plans/x.md' })
    expect(result.success).toBe(true)
  })
})

describe('planner default plan dir', () => {
  test('defaults to a workspace/ subdir (free-write zone for trusted callers)', () => {
    expect(PLANNER_DEFAULT_PLAN_DIR).toBe('workspace/plans')
  })
})

describe('planner skill content', () => {
  test('PROJECT_PLAN_SKILL has the expected name/description/non-empty content', () => {
    expect(PROJECT_PLAN_SKILL.name).toBe('project')
    expect(PROJECT_PLAN_SKILL.description.length).toBeGreaterThan(0)
    expect(PROJECT_PLAN_SKILL.content.length).toBeGreaterThan(0)
  })

  test('GENERAL_PLAN_SKILL has the expected name/description/non-empty content', () => {
    expect(GENERAL_PLAN_SKILL.name).toBe('general')
    expect(GENERAL_PLAN_SKILL.description.length).toBeGreaterThan(0)
    expect(GENERAL_PLAN_SKILL.content.length).toBeGreaterThan(0)
  })

  test('project skill is domain-neutral: teaches multiple project kinds, not just code (drift guard)', () => {
    const lower = PROJECT_PLAN_SKILL.content.toLowerCase()
    expect(lower).toContain('trip')
    expect(lower).toContain('launch')
    expect(lower).toContain('migration')
  })

  test('project skill teaches the research-vs-ask distinction with per-domain load-bearing inputs', () => {
    const lower = PROJECT_PLAN_SKILL.content.toLowerCase()
    expect(lower).toContain('research vs')
    expect(lower).toContain('user-only')
    expect(lower).toContain('travel dates')
    expect(lower).toContain('do not plan around the void')
  })

  test('project skill teaches dependency sequencing and contingency (critical-path craft)', () => {
    const lower = PROJECT_PLAN_SKILL.content.toLowerCase()
    expect(lower).toContain('critical path')
    expect(lower).toContain('contingency')
    expect(lower).toContain('depends-on')
  })

  test('general skill teaches the research-vs-ask distinction (no lazy question dumping)', () => {
    const lower = GENERAL_PLAN_SKILL.content.toLowerCase()
    expect(lower).toContain('research it yourself')
    expect(lower).toContain('ask the caller')
    expect(lower).toContain('cannot research a preference')
  })

  test('general skill teaches hidden-assumption discipline (the universal planning failure mode)', () => {
    const lower = GENERAL_PLAN_SKILL.content.toLowerCase()
    expect(lower).toContain('hidden assumptions')
  })

  test('every shipped skill references the neutral plan-summary contract (so domain skills compose with the universal shape)', () => {
    for (const skill of PLANNER_SKILLS) {
      expect(skill.content).toContain('<plan-summary>')
    }
  })
})
