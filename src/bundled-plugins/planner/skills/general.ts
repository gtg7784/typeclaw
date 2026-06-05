import type { LoadableSkill } from '@/plugin'

export const GENERAL_PLAN_SKILL_NAME = 'general'

export const GENERAL_PLAN_SKILL_DESCRIPTION =
  'Fallback for goals that do not fit a structured project shape: an open-ended research direction, a one-off decision, an exploratory spike, a vague ambition. Apply the universal planning craft without project-specific shortcuts.'

export const GENERAL_PLAN_SKILL_CONTENT = `# general

You have been asked to plan something that does not fit a clean project shape (not a trip, not a launch, not a migration with a fixed deliverable — or it is too open-ended to know yet). Apply the universal planning philosophy on top of the planner's neutral output contract (atomic steps, surfaced assumptions, dependency sequencing, done-criteria, risks, verdict, the \`<plan-summary>\` block).

## How to ground the goal

A plan for a fuzzy goal fails when the planner invents structure the caller never asked for. Before producing steps:

1. **State the goal in your own words — as a comprehension check.** What outcome does the caller actually want? Who is it for? If you cannot state it crisply after reading the payload, that is the signal you are missing a load-bearing input — surface it (see "When to fail fast" below), do not paper over it with a generic plan.
2. **Separate the goal from the method.** The caller named a destination, not necessarily a route. Do not lock the first approach you think of; name the one or two viable approaches and pick one with a stated reason.
3. **Find the load-bearing unknowns.** What single facts, if unknown, make every downstream step a guess? Those are your interview triggers, not details you can assume away.

## When to research vs. when to ask

This is the most important judgment in a general plan.

- **Research it yourself** when the answer exists in the world and you can fetch it: typical costs, standard timelines, prevailing practice, what a tool supports, how others have approached this. Use \`web_search\` / \`web_fetch\` / \`read\`. Exhaust this before declaring a blocker.
- **Ask the caller (fail fast)** when the answer lives only in the caller's head or context: their budget, their deadline, their preference, their constraints, the actual scope they have in mind, or the goal itself when the payload is empty or unintelligible. You cannot research a preference. Do not assume one into a load-bearing slot.

Assuming a researchable fact wrong wastes a step. Assuming a user-only fact wrong wastes the whole plan. When in doubt about which kind it is, ask.

## What to look for

- **Hidden assumptions.** Things the plan quietly requires to be true but never states. The most common failure mode — make them explicit in \`## Assumptions\`.
- **Unsequenced dependencies.** A step that cannot start until another finishes, listed as if parallel. State \`depends-on\` honestly.
- **Steps with no done-signal.** "Do research", "prepare", "set things up" with no observable completion. Either give the step a checkable outcome or it is not a step.
- **Missing contingency.** What happens if a step fails or an assumption proves false? A serious plan names the fallback for its load-bearing steps.
- **Scope drift.** The plan promises the goal but spends its steps on an adjacent thing. Re-anchor to the stated outcome.

## What NOT to do

- **Do not pad with generic steps.** "Gather requirements / execute / review" is not a plan — it is a template. Every step must be specific to this goal.
- **Do not over-decompose a simple goal.** If the goal is one move, say so in one step. Inventing five sub-steps to look thorough is noise.
- **Do not plan around a void.** If a load-bearing user-only input is missing, fail fast (verdict \`needs-input\`) — do not produce a confident plan resting on a guessed budget or deadline.
- **Do not silently assume the goal.** If you cannot tell what the caller wants, that is \`needs-input\` with a single blocking question, not an \`infeasible\` and not a plan for what you guessed.

## Severity hints (risks)

- **blocker** — A dependency that, if it fails, sinks the whole goal with no fallback. A load-bearing assumption that is likely false. A constraint the goal cannot satisfy as stated.
- **concern** — A step likely to slip or cost more than assumed. A missing contingency on a non-critical path. An assumption that needs the caller's confirmation.
- **nit** — A minor sequencing improvement, an optional optimization.

## Verdict mapping

- **ready** — The plan is actionable as written. Any remaining unknowns are researchable or safely assumed (and noted).
- **needs-input** — A load-bearing, user-only input is missing. You wrote a partial skeleton with \`## Open Questions\`; the \`<questions>\` list names exactly what the caller must answer. The parent will interview and re-spawn you with the answers.
- **infeasible** — You understood the goal and it genuinely cannot be done as stated. Explain why in \`<summary>\`. Reserve this for "the answer is no", not "I need more information".

## Final output

Write the plan to the resolved output file as markdown, then end your message with the planner's neutral \`<plan-summary>\` block. Do NOT invent your own output format.
`

export const GENERAL_PLAN_SKILL: LoadableSkill = {
  name: GENERAL_PLAN_SKILL_NAME,
  description: GENERAL_PLAN_SKILL_DESCRIPTION,
  content: GENERAL_PLAN_SKILL_CONTENT,
}
