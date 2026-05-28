import { z } from 'zod'

import { defineTool } from './define'
import type { Tool } from './types'

// One unit of curated skill content a subagent can load on demand. The
// `name` becomes a value in the tool's `name` enum; `description` is what
// the model sees in the tool description block so it can decide which
// skill to load WITHOUT having to load it first; `content` is the body
// returned by the tool when the model picks this skill.
export type LoadableSkill = {
  name: string
  description: string
  content: string
}

export type CreateLoadSkillToolOptions = {
  skills: readonly LoadableSkill[]
  // Override the tool's top-level description. Defaults to a generic
  // explanation of how the tool works followed by the per-skill menu.
  // Plugins can pass a more specific framing (e.g. "Load a review skill
  // …") so the subagent's instructions line up with the tool name.
  description?: string
}

export type LoadSkillArgs = { name: string }

// Build a typed `load_skill` tool a subagent can call to fetch the body
// of a curated skill on demand. The factory closes over the `skills`
// list so:
//   - the `name` parameter is a Zod enum narrowed to exactly the skill
//     names the caller supplied (typo-resistant; the model sees the
//     allowed values in the tool's JSON Schema),
//   - the tool's `description` lists every skill's name + description so
//     the model can choose the right one BEFORE calling the tool, paying
//     only one tool-call's worth of context for the body it actually
//     needs,
//   - unknown names are rejected by parameter validation, not by the
//     handler — the runtime returns the validation error before
//     `execute` runs.
//
// This is the runtime-loaded counterpart to TypeClaw's startup-time
// skill discovery (`additionalSkillPaths` in `src/agent/index.ts`).
// Subagents bypass the file-based resource loader, so the startup path
// is unavailable to them; this factory gives plugin authors a typed way
// to expose curated skills to their subagents via `customTools`.
export function createLoadSkillTool(options: CreateLoadSkillToolOptions): Tool<LoadSkillArgs> {
  const { skills } = options

  if (skills.length === 0) {
    throw new Error('createLoadSkillTool: `skills` must contain at least one entry')
  }

  const seen = new Set<string>()
  for (const skill of skills) {
    if (skill.name.length === 0) {
      throw new Error('createLoadSkillTool: skill name must be non-empty')
    }
    if (seen.has(skill.name)) {
      throw new Error(`createLoadSkillTool: duplicate skill name ${JSON.stringify(skill.name)}`)
    }
    seen.add(skill.name)
  }

  // z.enum requires a `[string, ...string[]]` tuple. Build it from the
  // skill list so the JSON Schema surfaced to the model lists exactly
  // the allowed values.
  const names = skills.map((s) => s.name) as [string, ...string[]]

  const description = options.description ?? buildDefaultDescription(skills)

  return defineTool<LoadSkillArgs>({
    description,
    parameters: z.object({
      name: z.enum(names).describe('The name of the skill to load. Must match one of the available skills.'),
    }),
    async execute(args) {
      const skill = skills.find((s) => s.name === args.name)
      if (skill === undefined) {
        // Defensive: Zod enum validation should have rejected this
        // before reaching the handler. Surface a clear message anyway.
        const available = names.join(', ')
        throw new Error(`Unknown skill ${JSON.stringify(args.name)}. Available skills: ${available}.`)
      }
      return {
        content: [{ type: 'text' as const, text: skill.content }],
        details: { name: skill.name, contentBytes: skill.content.length },
      }
    },
  })
}

function buildDefaultDescription(skills: readonly LoadableSkill[]): string {
  const menu = skills.map((s) => `- \`${s.name}\` — ${s.description}`).join('\n')
  return `Load a curated skill by name. Returns the full skill body as text so you can apply it to the current task. Call this when you have identified which skill matches the task; do NOT load multiple skills speculatively.

Available skills:
${menu}`
}
