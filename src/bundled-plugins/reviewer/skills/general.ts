import type { LoadableSkill } from '@/plugin'

export const GENERAL_REVIEW_SKILL_NAME = 'general'

export const GENERAL_REVIEW_SKILL_DESCRIPTION =
  'Fallback for review targets that do not fit a specific domain skill: a written argument, a proposal, a draft, a mixed-format artifact. Apply the universal review philosophy without domain-specific shortcuts.'

export const GENERAL_REVIEW_SKILL_CONTENT = `# general

You have been asked to review something that does not clearly fit a specific domain skill (not a code PR, not a plan, not a design doc, not docs — or it is a mix). Apply the universal review philosophy on top of the reviewer's neutral output contract.

## How to acquire the target

- **A URL** — \`web_fetch\` it. If it is a private resource the fetch cannot reach, say so in \`<summary>\` and review what was provided in the payload.
- **A file path** — \`read\` it. \`ls\` the parent directory if siblings might be relevant.
- **Inline text in the payload** — read the payload carefully; quote from it when forming evidence.
- **A reference to something the caller has** — ask the caller to provide it. Return a single \`blocker\` finding describing what you need and a \`comment\` verdict.

## How to read carefully

A general review is the hardest because there are no domain shortcuts. Replace shortcuts with discipline:

1. **State the target's purpose in your own words — to yourself, as a comprehension check.** What is the artifact trying to achieve? Who is it for? If you cannot state it after reading, that itself is a finding — the artifact does not communicate its purpose. This is your private grounding, not summary copy: keep the restatement out of \`<summary>\`, which stays a terse verdict justification per the output contract.
2. **Identify the load-bearing claims.** What does the artifact assert that, if wrong, would invalidate the whole thing? List them mentally before looking for issues.
3. **Stress-test the load-bearing claims.** For each one: is the evidence sufficient? Are the assumptions stated? Are the counter-arguments addressed?
4. **Stress-test the boundaries.** Where does the artifact's argument or design stop applying? Does it acknowledge that boundary, or does it overgeneralize?
5. **Stress-test the audience fit.** Will the intended reader understand it? Is the prerequisite knowledge stated? Are the unstated assumptions reasonable for that audience?

## What to look for

- **Internal contradiction.** Two statements that cannot both be true. The artifact must reconcile them or pick one.
- **Unsupported claims.** Any assertion the artifact relies on but does not justify. The author may have a reason — say so and ask, do not assume incompetence.
- **Hidden assumptions.** Things the argument quietly requires to be true but does not state. These are the most common failure mode in general writing.
- **Missing alternatives.** If the artifact recommends X, did it explain why not Y? A serious proposal acknowledges the alternatives it rejected.
- **Scope drift.** The artifact promises to cover A but spends half its bytes on B. Either the scope is wrong or the title is wrong.
- **Verifiability.** If the artifact claims success criteria, are they measurable? "Better performance" with no metric is unverifiable.
- **Logical structure.** Premises → reasoning → conclusion. Where the chain breaks, point at the break.

## What NOT to find

- **Stylistic preferences.** Sentence rhythm, word choice variation, paragraph length. Skip unless they actively impede understanding.
- **Re-summarizing the artifact as a finding.** "This document discusses X" is not a review.
- **Generic feedback.** "Could be clearer" without pointing at a specific passage is noise.
- **Disagreements that are taste, not error.** If the author chose path A and you would have chosen B, that is not a finding unless A is actually worse for a stated reason.

## Severity hints

- **blocker** — A logical break, a fatal contradiction, a load-bearing claim that is verifiably false, an audience-fit problem so severe the intended reader cannot use the artifact.
- **concern** — An unsupported claim that needs justification, a missing alternative that weakens the recommendation, a scope ambiguity that will mislead readers.
- **nit** — A small clarity issue, a passage that could be tightened, a minor inconsistency.
- **praise** — A non-obvious insight, a tricky trade-off well-handled, a passage that earns the reader's trust. Rare.

## Verdict mapping

- **approve** — No blockers. The artifact stands on its own.
- **request-changes** — At least one blocker.
- **comment** — Useful observations without a clean accept/reject. Common for early drafts, exploratory documents, or partial reviews.

## Final output

Return findings inside the reviewer's neutral \`<review>\` block. Do NOT invent your own output format.
`

export const GENERAL_REVIEW_SKILL: LoadableSkill = {
  name: GENERAL_REVIEW_SKILL_NAME,
  description: GENERAL_REVIEW_SKILL_DESCRIPTION,
  content: GENERAL_REVIEW_SKILL_CONTENT,
}
