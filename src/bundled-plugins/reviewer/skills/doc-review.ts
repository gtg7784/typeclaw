import type { LoadableSkill } from '@/plugin'

export const DOC_REVIEW_SKILL_NAME = 'doc-review'

export const DOC_REVIEW_SKILL_DESCRIPTION =
  'Review technical documentation: a README, a guide, an API reference, a tutorial, a how-to. Covers doc-type fit, prerequisites, runnable examples, cross-references, version drift, terminology consistency, and accessibility.'

export const DOC_REVIEW_SKILL_CONTENT = `# doc-review

You have been asked to review technical documentation. Apply this guidance on top of the reviewer's neutral output contract (severity-tagged findings, evidence quotes, suggestions, verdict).

## How to acquire the target

- **A file path** — \`read\` it. \`ls\` the docs directory to see how this page fits the larger set; a page is reviewed in the context of its neighbors.
- **A URL** — \`web_fetch\` it. If it is a private docs site the fetch cannot reach, say so in \`<summary>\` and review what the payload provided.
- **A PR that touches docs** — \`gh pr diff <n>\` for the changed pages; \`read\` the surrounding sections the diff did not touch, because a doc edit is judged against the whole page's flow, not the hunk alone.
- **A doc set / directory** — \`ls\` and \`grep\` for the navigation/index file; a finding about findability needs the table of contents, not just one page.

## Identify the doc type first

Most documentation defects are really one defect: the page is the wrong *type* for what the reader needs. Before looking for anything else, classify the target against the four Diátaxis modes, because the right content for one is wrong for another:

- **Tutorial** — learning-oriented. A guaranteed-to-succeed lesson for a newcomer. Concrete, linear, no detours.
- **How-to guide** — task-oriented. Steps to achieve one stated goal for someone who already knows the basics.
- **Reference** — information-oriented. Dry, complete, accurate description of the API/CLI/config. No teaching.
- **Explanation** — understanding-oriented. The "why" and the trade-offs. No step-by-step.

A page that mixes modes — a tutorial padded with architecture explanation, a reference that drifts into opinion — fails the reader who came for one of them. Naming the type-mismatch is usually the highest-value finding you can make.

## What to look for

1. **Doc-type bleed.** Conceptual explanation injected into a first-run tutorial; a how-to guide that stops to teach theory; a reference page editorializing. State which mode the page is and which content belongs elsewhere.
2. **Missing prerequisites.** The page assumes a tool, a version, an account, or a prior step that is never stated before the reader needs it. A first \`install\` step that silently requires Docker running is a prerequisite gap.
3. **Untested or broken code samples.** Examples that will not run as written: deprecated flags, wrong import paths, a command that references a removed subcommand. When you can, trace the sample against the real CLI/API surface in the repo and cite the contradiction.
4. **Broken or stale cross-references.** Links that 404, "see the section below" pointing at a section that no longer exists, references to a renamed page. Internal anchors that drifted after a heading was retitled.
5. **Version drift.** Text, flags, screenshots, or output that describe an older release than the one the docs ship with. Cite the current value (from the repo, the CLI help, the changelog) against the stale one.
6. **Terminology inconsistency.** The same concept called three names across the page ("workspace" / "project" / "folder") with no statement that they are the same. Pick the canonical term and flag the drift.
7. **Accessibility defects.** Images with no alt text, heading levels that skip (h1 → h3), meaning carried by color alone, link text that is bare "click here". These are real findings, not nits, when they block a reader using assistive tech.
8. **Findability.** A page that cannot be reached from the index, a missing "next step" at the end of a tutorial, a reference with no anchor for the field a reader will search for.

## What NOT to find

- **Formatter / linter territory.** Trailing whitespace, line length, fenced-block language tags, Markdown table alignment. Assume a docs linter ran. Do not raise it.
- **House-style preferences the page follows.** If the project writes in second person, or uses sentence-case headings, or prefers "e.g." over "for example", and the page matches, that is not a finding. Only the deviation is.
- **Restating the doc as a finding.** "This page documents the start command" is not a review.
- **Rewriting for taste.** A sentence you would have phrased differently but that reads clearly for the intended audience is not a finding. Clarity is the bar, not your preferred cadence.
- **Generic "add more examples".** Without naming the specific step or field that is under-documented, "could use more examples" is noise.

## Severity hints specific to docs

- **blocker** — A code sample that fails for everyone who runs it. A prerequisite gap that strands the reader at step one. A reference value that is factually wrong (wrong default, wrong type) and will cause the reader to misconfigure the system. Doc-type bleed so severe the page does not serve the reader it is for.
- **concern** — A stale flag or version reference that still mostly works but will mislead. A missing prerequisite for a later (not first) step. Terminology drift that will confuse a newcomer. An accessibility defect that degrades but does not block.
- **nit** — A single awkward sentence, a missing "next step" link, a minor terminology wobble in an aside. Optional.
- **praise** — A tutorial that genuinely lands a beginner at a working state, a reference table that is complete and scannable, an explanation that makes a hard concept click. Rare.

## Verdict mapping

- **approve** — Publishable. The page serves its reader; any gaps are nits.
- **request-changes** — At least one blocker: a sample that fails, a factually wrong reference, a prerequisite gap that strands the reader.
- **comment** — Useful observations without a clean accept/reject. Common for an early docs draft or a partial review of a large doc set.

## Final output

Return findings inside the reviewer's neutral \`<review>\` block. Do NOT invent your own output format.
`

export const DOC_REVIEW_SKILL: LoadableSkill = {
  name: DOC_REVIEW_SKILL_NAME,
  description: DOC_REVIEW_SKILL_DESCRIPTION,
  content: DOC_REVIEW_SKILL_CONTENT,
}
