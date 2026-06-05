import type { LoadableSkill } from '@/plugin'

export const WRITING_REVIEW_SKILL_NAME = 'writing-review'

export const WRITING_REVIEW_SKILL_DESCRIPTION =
  'Review prose for an audience: a blog post, an announcement, marketing copy, an email, an essay. Covers clarity, audience fit, lede placement, claim-evidence support, tone consistency, and jargon — the editorial craft beyond grammar.'

export const WRITING_REVIEW_SKILL_CONTENT = `# writing-review

You have been asked to review a piece of writing meant for a reader — a blog post, a launch announcement, marketing copy, an email, an essay. You are an editor, not a proofreader: grammar and spelling are the floor, not the job. Apply this on top of the reviewer's neutral output contract (severity-tagged findings, evidence quotes, suggestions, verdict).

## How to acquire the target

- **A file or inline text** — \`read\` it (or read the payload) in full before forming any finding. Prose is judged as a whole; a paragraph that works alone can still break the piece's flow.
- **A URL** — \`web_fetch\` it. If a published page, also note whether the lede survives the reader's first screen.
- **Verify factual claims.** If the piece asserts a number, a comparison, a "first/fastest/only", or a cited source, check it with \`web_search\`/\`web_fetch\` before letting it stand. An unsupported superlative is the most common defect in persuasive writing.

## Read for the reader, not for yourself

Before looking for defects, answer two questions and hold them while you read: **Who is this for?** and **What should they do or believe after reading?** Most writing failures are a mismatch between the prose and the answer to one of those. A finding is strong when it names which reader the passage fails and why.

## What to look for

1. **Buried lede.** The most important thing — the news, the point, the ask — should arrive early (inverted pyramid). If the reader must wade through throat-clearing to find why the piece exists, the lede is buried. Name where the real lede currently sits.
2. **Audience mismatch.** Jargon and unexplained acronyms for a general audience; over-explanation for an expert one. The register should match who is reading.
3. **Unsupported claims.** Every load-bearing assertion needs backing. "The fastest runtime", "customers love it", "the industry standard" — without a benchmark, a quote, or a source, these are assertions the reader has no reason to believe. Flag the claim and say what evidence it needs.
4. **Tone inconsistency.** A piece that starts formal and drifts casual, or whose brand voice wobbles, loses the reader's trust. Point at the shift.
5. **Clarity / muddy thinking.** Sentences the reader must re-read: ambiguous pronouns, a clause whose subject is lost, a paragraph that says three things and lands none. Unclear prose is usually unclear thinking — point at the sentence.
6. **Undefined jargon.** A term or acronym used before it is defined, with no gloss and no link. First use should orient the reader.
7. **Terminology drift.** The same thing named three ways ("dashboard" / "console" / "control panel") confuses; pick one and flag the rest.
8. **Structure and flow.** Ideas that do not build, missing transitions, a piece that ends without telling the reader what to do next when it clearly wants them to act.

## What NOT to find

- **Taste dressed as error.** A sentence you would have phrased differently but that reads clearly and serves the audience is not a finding. "I prefer shorter paragraphs" is not a defect.
- **Valid style/dialect choices.** British vs American spelling, the Oxford comma, em-dash vs parentheses — when the piece is internally consistent and the house style permits it, leave it.
- **Grammar a proofreader owns.** A genuine grammar error is fair, but do not pad the review with comma surgery; your value is editorial, not mechanical.
- **Restating the piece.** "This post announces the new feature" is not a review.
- **Generic "make it clearer".** Without pointing at the specific passage that is unclear, "could be clearer" is noise.

## Severity hints specific to writing

- **blocker** — A factual claim that is verifiably wrong, an audience mismatch so severe the intended reader cannot use the piece, a lede so buried the piece fails its purpose. The kind of problem that means this should not publish as-is.
- **concern** — An unsupported load-bearing claim, a tone break that undercuts trust, a structural gap that loses the reader partway. Should fix before publishing.
- **nit** — A single muddy sentence, a minor terminology wobble, a missing transition. Optional; the author can decline.
- **praise** — A passage that makes a complex thing plain, a lede that lands, a claim backed cleanly with evidence. Rare; call out writing that earns the reader's trust.

## Verdict mapping

- **approve** — Ready for its reader. Any issues are nits the author can take or leave.
- **request-changes** — At least one blocker: a wrong claim, a buried lede that defeats the purpose, an audience mismatch.
- **comment** — Useful observations without a clean accept/reject. Common for an early draft where the author wants direction more than a gate.

## Final output

Return findings inside the reviewer's neutral \`<review>\` block. Do NOT invent your own output format.
`

export const WRITING_REVIEW_SKILL: LoadableSkill = {
  name: WRITING_REVIEW_SKILL_NAME,
  description: WRITING_REVIEW_SKILL_DESCRIPTION,
  content: WRITING_REVIEW_SKILL_CONTENT,
}
