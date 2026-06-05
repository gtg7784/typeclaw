import type { LoadableSkill } from '@/plugin'

export const PROJECT_PLAN_SKILL_NAME = 'project'

export const PROJECT_PLAN_SKILL_DESCRIPTION =
  'Plan a multi-step goal with resources, dependencies, and a target date: a trip, a product launch, a system migration, a software feature, an event, a campaign. Covers constraint gathering, dependency sequencing, milestones, and contingency.'

export const PROJECT_PLAN_SKILL_CONTENT = `# project

You have been asked to plan a project — a goal with several moving parts, real-world resources, dependencies between steps, and usually a date it needs to land by. A trip, a product launch, a migration, an event, a feature, a campaign all share this shape. Apply this guidance on top of the planner's neutral output contract (atomic steps, surfaced assumptions, dependency sequencing, done-criteria, risks, verdict, the \`<plan-summary>\` block).

## Gather the constraints first

A project plan is only as good as the constraints it respects. Before sequencing anything, establish:

1. **The deadline or window.** When must this be done, or what is the rough timeframe? Everything downstream (how much can fit, what to cut) depends on it.
2. **The budget or resource ceiling.** Money, people, time, compute — whatever the limiting resource is. A plan that ignores the ceiling is a wishlist.
3. **The fixed points.** Non-negotiables the caller already decided: the destination, the launch channel, the target system, the venue. Do not re-plan these; plan around them.
4. **The success condition.** What does "done well" look like to the caller? This is the bar each milestone is checked against.

Some of these you can research; some only the caller knows. Sort them honestly (next section) before you commit to a plan.

## Research vs. ask — the load-bearing distinction

- **Research it yourself** when the fact exists in the world: typical flight prices for those dates, standard lead time for a launch asset, how long a data migration of this size usually takes, what a venue holds. Use \`web_search\` / \`web_fetch\` / \`read\`. A good project plan is grounded in fetched reality, not vibes — exhaust research before declaring a blocker.
- **Ask the caller (fail fast)** when only they hold it. These are the classic per-domain load-bearing inputs:
  - **Trip** — travel dates (or window + length), total budget and whether it includes transport, the destination if unstated, who is going.
  - **Launch** — the launch date, the target audience, the channels, the budget.
  - **Migration** — the cutover window, the rollback tolerance, the source/target the caller has decided on, the data scale if you cannot measure it yourself.
  - **Event** — the date, the headcount, the budget, the venue constraints.

  When a load-bearing user-only input is missing, **STOP — do not plan around the void.** Burning your analysis budget half-planning a trip with no dates or budget is the actual failure. Write a minimal partial (the skeleton + an \`## Open Questions\` section) and return verdict \`needs-input\` with a \`<questions>\` list. The parent owns the channel; it will interview the caller and re-spawn you with the answers. Failing fast here is correct behavior.

## Build the plan

1. **Decompose into milestones, each a checkable outcome.** "Book transport", "secure the venue", "cut over the database" — not "prepare" or "handle logistics". Each milestone gets a \`done when\` signal.
2. **Sequence by dependency, not wishful order.** State \`depends-on\` honestly: you cannot build the daily itinerary before the dates are fixed; you cannot announce the launch before the asset is ready. Surface the critical path — the chain that determines the earliest finish.
3. **Size each step.** Rough effort (S/M/L) so the caller can see where the weight is. If a single step dominates the timeline, say so.
4. **Build in contingency.** For every load-bearing step, name what happens if it slips or fails — the fallback, the buffer, the rollback. A migration plan without a rollback is incomplete; a trip plan with no weather/sold-out fallback is fragile.

## What NOT to do

- **Do not assume the ceiling.** A guessed budget or deadline silently invalidates every step that rests on it. If it is user-only and missing, ask.
- **Do not produce a confident plan on a guessed fixed point.** If you do not know the destination, the target system, or the date, that is \`needs-input\`, not a plan for the one you imagined.
- **Do not over-decompose.** A weekend trip is not a fifteen-step project. Match the plan's weight to the goal's.
- **Do not skip the contingency on the critical path.** The steps most likely to sink the goal are exactly the ones that need a stated fallback.

## Severity hints (risks)

- **blocker** — A critical-path step with no fallback that, if it fails, sinks the whole project (the only flight sells out, the cutover has no rollback). A constraint the goal cannot meet as stated (the budget cannot cover the fixed points).
- **concern** — A step likely to slip, a dependency on an external party with no buffer, a cost estimate that could blow the ceiling, a milestone with a soft done-signal.
- **nit** — A sequencing tweak, an optional optimization, a nice-to-have buffer.

## Verdict mapping

- **ready** — Constraints are known (researched or supplied), the plan respects the ceiling, the critical path has contingency. Actionable as written.
- **needs-input** — A user-only load-bearing constraint is missing (dates, budget, a fixed point, or the goal itself). Partial skeleton written with \`## Open Questions\`; \`<questions>\` names exactly what to ask. The parent interviews and re-spawns.
- **infeasible** — The goal genuinely cannot be done within the stated constraints (the budget cannot cover the fixed points no matter how you sequence it). Explain why; this is "the answer is no", not "I need more information".

## Final output

Write the plan to the resolved output file as markdown, then end your message with the planner's neutral \`<plan-summary>\` block. Do NOT invent your own output format.
`

export const PROJECT_PLAN_SKILL: LoadableSkill = {
  name: PROJECT_PLAN_SKILL_NAME,
  description: PROJECT_PLAN_SKILL_DESCRIPTION,
  content: PROJECT_PLAN_SKILL_CONTENT,
}
