import { describe, expect, test } from 'bun:test'

import {
  RESEARCHER_SKILLS,
  RESEARCHER_SYSTEM_PROMPT,
  createResearcherSubagent,
  researcherPayloadSchema,
} from './researcher'
import { GENERAL_RESEARCH_SKILL } from './skills/general'

describe('researcher subagent — load-bearing prompt phrases', () => {
  test.each(
    [
      'SIDE EFFECTS',
      'STRICTLY PROHIBITED',
      'parallel',
      '<analysis>',
      '<report>',
      '<summary>',
      '<report_file>',
      '<confidence>',
      '<open_questions>',
      'load_skill',
    ].map((phrase) => [phrase] as const),
  )('prompt contains %s', (phrase) => {
    const haystack = RESEARCHER_SYSTEM_PROMPT.toLowerCase()
    expect(haystack).toContain(phrase.toLowerCase())
  })

  test('prompt frames the role as domain-neutral research, NOT a coding assistant', () => {
    // The whole point of this subagent is general-purpose research (markets,
    // history, science, policy). If a future edit narrows it to code research,
    // it stops serving the runtime's actual breadth and this guard fails.
    const lower = RESEARCHER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('domain-neutral')
    expect(lower).toContain('not a coding assistant')
    expect(lower).toContain('research analyst')
  })

  test('prompt frames the role as the deep counterpart to scout (and redirects simple lookups to scout)', () => {
    // The scout/researcher split only holds if researcher redirects trivial
    // single-fact lookups back to scout. Without it, the expensive deep model
    // gets spent on questions scout could answer in one pass.
    expect(RESEARCHER_SYSTEM_PROMPT).toContain('scout')
    const lower = RESEARCHER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('quality, not speed')
    expect(lower).toContain('spawn `scout` directly')
  })

  test('prompt scopes side effects to exactly ONE write via the enforced write_report tool, no general writer', () => {
    // The researcher is the one read-mostly subagent that can write a file. The
    // contract that keeps it safe is "one report file via write_report, nowhere
    // else, no general write/bash-write". If this erodes, the subagent becomes a
    // general write vector — the exact gap a security review flagged.
    const lower = RESEARCHER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('one scoped write')
    expect(lower).toContain('only side effect')
    expect(lower).toContain('write_report')
    expect(lower).toContain('no general file-write tool')
  })

  test('prompt forbids bash for write/mutating operations (bash stays read-only)', () => {
    expect(RESEARCHER_SYSTEM_PROMPT).toContain('mkdir')
    expect(RESEARCHER_SYSTEM_PROMPT).toContain('rm')
    expect(RESEARCHER_SYSTEM_PROMPT).toContain('git add')
    expect(RESEARCHER_SYSTEM_PROMPT).toContain('git commit')
    expect(RESEARCHER_SYSTEM_PROMPT).toContain('git push')
  })

  test('prompt names the dedicated tools by their exact runtime names', () => {
    expect(RESEARCHER_SYSTEM_PROMPT).toContain('`read`')
    expect(RESEARCHER_SYSTEM_PROMPT).toContain('`grep`')
    expect(RESEARCHER_SYSTEM_PROMPT).toContain('`find`')
    expect(RESEARCHER_SYSTEM_PROMPT).toContain('`ls`')
    expect(RESEARCHER_SYSTEM_PROMPT).toContain('`bash`')
    expect(RESEARCHER_SYSTEM_PROMPT).toContain('`web_search`')
    expect(RESEARCHER_SYSTEM_PROMPT).toContain('`web_fetch`')
    expect(RESEARCHER_SYSTEM_PROMPT).toContain('`write_report`')
    expect(RESEARCHER_SYSTEM_PROMPT).toContain('`load_skill`')
  })

  test('prompt instructs the researcher to load a skill BEFORE gathering (architectural intent)', () => {
    const lower = RESEARCHER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('load_skill')
    expect(lower).toContain('first thing you do')
    expect(lower).toContain('do not start gathering before loading a skill')
  })

  test('prompt is domain-neutral: does NOT inline a topic-specific research workflow in the base prompt', () => {
    // Drift guard mirroring reviewer's: domain-specific craft (market sizing
    // steps, archival-research steps) lives in skills, not the base prompt. If
    // a future edit pulls a single topic's workflow into the base prompt, the
    // researcher stops being general-purpose and this catches it.
    expect(RESEARCHER_SYSTEM_PROMPT).not.toContain('**Market research:**')
    expect(RESEARCHER_SYSTEM_PROMPT).not.toContain('**Historical research:**')
    expect(RESEARCHER_SYSTEM_PROMPT).not.toContain('**Code research:**')
  })

  test('prompt frames delegation as context-saving (deep model offloads bulk gathering to cheaper workers)', () => {
    const lower = RESEARCHER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('spawn_subagent')
    expect(lower).toContain('explorer')
    // The synthesis stays with the researcher — delegation gathers, never decides.
    expect(lower).toContain('delegate the gathering, never the conclusion')
  })

  test('prompt makes delegating to scout/explorer the DEFAULT for fetching, not just for big sweeps', () => {
    // The expensive deep model bleeds context if it fetches routine pages
    // itself. The prompt must push the model to delegate quick fetches to
    // scout/explorer by default and keep its own web_search/web_fetch/read/grep
    // for surgical touches only. If this softens back to "delegate big sweeps,
    // fetch the rest yourself", the context-economy intent is lost.
    const lower = RESEARCHER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('delegate first; fetch yourself only as a last resort')
    expect(lower).toContain('your default for gathering is to delegate')
    expect(lower).toContain('quick or broad')
  })

  test('prompt still forbids side effects through a delegate (no laundering write access via a subagent)', () => {
    const lower = RESEARCHER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('a subagent you spawn cannot do for you')
  })

  test('prompt enforces citation discipline: cite every claim, never invent a source, never answer from memory', () => {
    // The three load-bearing failure modes of a research agent: uncited prose,
    // hallucinated sources, and training-memory laundered as sourced fact. All
    // three rules must be present.
    const lower = RESEARCHER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('cite every claim')
    expect(lower).toContain('never invent a source')
    expect(lower).toContain('never answer a researchable question from training memory')
  })

  test('prompt requires cross-validation of load-bearing claims across independent sources', () => {
    const lower = RESEARCHER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('cross-validate')
    expect(lower).toContain('independent')
  })

  test('prompt forbids deciding for the caller (research surfaces evidence, the caller decides)', () => {
    const lower = RESEARCHER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('do not decide for the caller')
  })

  test('prompt requires a confidence rating so the caller can weight the report', () => {
    const lower = RESEARCHER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('confidence')
    expect(lower).toContain('low confidence, honestly reported, is useful')
  })

  test('prompt routes the report to workspace by default and falls back to public for untrusted callers', () => {
    // The workspace/public fallback is the load-bearing safety+visibility rule:
    // workspace/ is hidden from guest, so a report written there for a guest
    // caller is invisible to them. The subagent must self-route off its own
    // resolved role block. If this guidance is lost, guest-spawned researchers
    // silently produce unreadable reports.
    expect(RESEARCHER_SYSTEM_PROMPT).toContain('workspace/research-')
    expect(RESEARCHER_SYSTEM_PROMPT).toContain('public/research-')
    expect(RESEARCHER_SYSTEM_PROMPT).toContain('## Your role in this session')
    expect(RESEARCHER_SYSTEM_PROMPT).toContain('fs.see.private')
  })
})

describe('researcher subagent declaration', () => {
  test('is registered as visibility=public so spawn_subagent exposes it', () => {
    const sub = createResearcherSubagent()
    expect(sub.visibility).toBe('public')
  })

  test('uses the deep model profile (quality over speed, the deep counterpart to fast scout)', () => {
    const sub = createResearcherSubagent()
    expect(sub.profile).toBe('deep')
  })

  test('does NOT require a specific permission (member with generic subagent.spawn can spawn it)', () => {
    // Unlike operator, the researcher's only write is a sandboxed report file,
    // so it is NOT gated to owner/trusted. Flipping this to true would silently
    // lock member/guest out of research.
    const sub = createResearcherSubagent()
    expect(sub.requiresSpecificPermission ?? false).toBe(false)
  })

  test('declares canSpawnSubagents=true (deep researcher offloads bulk gathering to scout/explorer)', () => {
    const sub = createResearcherSubagent()
    expect(sub.canSpawnSubagents).toBe(true)
  })

  test('builtin tools are READ-ONLY: no generic write or edit (the writer is the enforced write_report custom tool)', () => {
    const sub = createResearcherSubagent()
    const toolNames = (sub.tools ?? []).map((t) => t.__builtinTool).sort()
    expect(toolNames).toEqual(['bash', 'find', 'grep', 'ls', 'read', 'web_fetch', 'web_search'])
    // Security drift guard (the review finding): the generic `write` tool's
    // runtime boundary (the non-workspace-write guard) is too broad for a
    // guest-spawnable subagent — it allowlists IDENTITY.md/cron.json/etc. and
    // honors acknowledgeGuards. The researcher must NOT hold it; its only writer
    // is the dedicated, code-enforced write_report custom tool. If a future edit
    // re-adds writeTool/editTool here, the hole reopens and this fails.
    expect(toolNames).not.toContain('write')
    expect(toolNames).not.toContain('edit')
  })

  test('customTools are exactly [load_skill, write_report] — the skill loader and the only file writer', () => {
    const sub = createResearcherSubagent()
    expect(sub.customTools).toBeDefined()
    expect(sub.customTools).toHaveLength(2)
    const [loadSkill, writeReport] = sub.customTools ?? []
    if (loadSkill === undefined || writeReport === undefined) throw new Error('expected load_skill + write_report')
    expect(loadSkill.description).toContain('`general`')
    expect(writeReport.description.toLowerCase()).toContain('research report')
  })

  test('load_skill parameter schema accepts the shipped skill name and rejects unknown ones', () => {
    const sub = createResearcherSubagent()
    const loadSkill = sub.customTools?.[0]
    if (loadSkill === undefined) throw new Error('load_skill tool missing')
    expect(loadSkill.parameters.safeParse({ name: 'general' }).success).toBe(true)
    expect(loadSkill.parameters.safeParse({ name: 'market-research' }).success).toBe(false)
    expect(loadSkill.parameters.safeParse({ name: '' }).success).toBe(false)
  })

  test('RESEARCHER_SKILLS ships exactly the general discipline skill (initial ship set)', () => {
    const names = RESEARCHER_SKILLS.map((s) => s.name)
    expect(names).toEqual(['general'])
  })

  test('declares a tool-result budget so a runaway research pass cannot exhaust parent context', () => {
    const sub = createResearcherSubagent()
    expect(sub.toolResultBudget).toBeDefined()
    expect(sub.toolResultBudget?.maxTotalBytes).toBeGreaterThan(0)
  })

  test('tool-result budget covers the builtin read/web tools and omits custom tools (which surface under __plugin_* names)', () => {
    // Custom tools (load_skill, write_report) are renamed to
    // `__plugin_researcher_researcher_<i>` at wrap time, so a name-keyed budget
    // entry for them would be dead config. The budget keys only the builtins.
    const sub = createResearcherSubagent()
    const names = sub.toolResultBudget?.toolNames ?? []
    expect([...names].sort()).toEqual(['bash', 'find', 'grep', 'ls', 'read', 'web_fetch', 'web_search'])
    expect(names).not.toContain('write')
    expect(names).not.toContain('load_skill')
    expect(names).not.toContain('write_report')
  })

  test('budget sits between explorer (256KB) and operator (1MB) — deep but bounded, bulk is delegated', () => {
    const sub = createResearcherSubagent()
    const budget = sub.toolResultBudget?.maxTotalBytes ?? 0
    expect(budget).toBeGreaterThan(256_000)
    expect(budget).toBeLessThan(1_000_000)
  })

  test('declares a spawn timeout so a stalled research pass fails the parent loudly instead of hanging forever', () => {
    const sub = createResearcherSubagent()
    expect(sub.timeoutMs).toBeGreaterThan(0)
  })

  test('spawn timeout is generous enough for a deep multi-source pass but not unbounded', () => {
    const sub = createResearcherSubagent()
    const timeout = sub.timeoutMs ?? 0
    expect(timeout).toBeGreaterThanOrEqual(60_000)
    expect(timeout).toBeLessThanOrEqual(1_800_000)
  })

  test('inFlightKey returns distinct values for distinct requestId payloads (parallel spawns must not coalesce)', () => {
    const sub = createResearcherSubagent()
    const k1 = sub.inFlightKey?.({ requestId: 'bg_a' })
    const k2 = sub.inFlightKey?.({ requestId: 'bg_b' })
    expect(k1).toBe('bg_a')
    expect(k2).toBe('bg_b')
    expect(k1).not.toBe(k2)
  })

  test('inFlightKey falls back to a random value when no requestId is provided (no accidental coalescing)', () => {
    const sub = createResearcherSubagent()
    const k1 = sub.inFlightKey?.({})
    const k2 = sub.inFlightKey?.({})
    expect(k1).not.toBe(k2)
  })
})

describe('researcher skill content', () => {
  test('GENERAL_RESEARCH_SKILL has the expected name/description/non-empty content', () => {
    expect(GENERAL_RESEARCH_SKILL.name).toBe('general')
    expect(GENERAL_RESEARCH_SKILL.description.length).toBeGreaterThan(0)
    expect(GENERAL_RESEARCH_SKILL.content.length).toBeGreaterThan(0)
  })

  test('general skill teaches domain-neutral research craft (drift guard against narrowing to code)', () => {
    // The description must advertise the breadth (market/history/science) so the
    // model picks it for any topic, and the body must teach universal craft.
    const lowerDesc = GENERAL_RESEARCH_SKILL.description.toLowerCase()
    expect(lowerDesc).toContain('market')
    expect(lowerDesc).toContain('historical')
    const lower = GENERAL_RESEARCH_SKILL.content.toLowerCase()
    expect(lower).toContain('primary source')
    expect(lower).toContain('cross-validate')
    expect(lower).toContain('circular citation')
    expect(lower).toContain('confidence calibration')
  })

  test('general skill suppresses the core research failure modes (drift guards)', () => {
    const lower = GENERAL_RESEARCH_SKILL.content.toLowerCase()
    expect(lower).toContain('do not answer a researchable question from training memory')
    expect(lower).toContain('do not invent or guess sources')
    expect(lower).toContain('do not make the decision for the caller')
  })

  test('every shipped skill references the researcher neutral output contract (so domain skills compose with it)', () => {
    for (const skill of RESEARCHER_SKILLS) {
      expect(skill.content).toContain('<report>')
    }
  })

  test('general skill carries the report-file skeleton (so the writer has a concrete structure)', () => {
    const lower = GENERAL_RESEARCH_SKILL.content.toLowerCase()
    expect(lower).toContain('## findings')
    expect(lower).toContain('## sources')
    expect(lower).toContain('## open questions')
  })
})

describe('researcherPayloadSchema', () => {
  test('accepts a full payload with requestId + prompt + description', () => {
    const result = researcherPayloadSchema.safeParse({
      requestId: 'bg_t1',
      prompt: 'is the global market for X growing year over year',
      description: 'market growth research',
    })
    expect(result.success).toBe(true)
  })

  test('accepts a payload with only requestId (spawn-tool minimum)', () => {
    const result = researcherPayloadSchema.safeParse({ requestId: 'bg_t1' })
    expect(result.success).toBe(true)
  })

  test('passes through unknown fields (forward-compat with future spawn-tool params, matches scout/reviewer/operator)', () => {
    const result = researcherPayloadSchema.safeParse({ requestId: 'bg_t1', futureField: 42 })
    expect(result.success).toBe(true)
  })
})
