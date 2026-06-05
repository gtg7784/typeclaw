import type { LoadableSkill } from '@/plugin'

export const GENERAL_RESEARCH_SKILL_NAME = 'general'

export const GENERAL_RESEARCH_SKILL_DESCRIPTION =
  'Fallback for any research question that does not fit a specific domain skill: market sizing, historical and document research, scientific literature, competitive and due-diligence analysis, policy and regulation, current events, fact-finding. Apply the universal research discipline without domain-specific shortcuts.'

export const GENERAL_RESEARCH_SKILL_CONTENT = `# general

You have been asked to investigate an open question that does not clearly fit a specific domain skill. Apply this universal research discipline on top of the researcher's neutral output contract (a written report file plus a \`<report>\` block: summary, report file path, confidence, open questions).

General research is the hardest kind because there are no domain shortcuts. Replace shortcuts with discipline.

## Scope the question before you gather

A pile of facts is not research. Before searching:

1. **Restate the question in your own words — to yourself, as a comprehension check.** What is actually being asked? What would a complete answer let the caller do? If you cannot state this after reading the payload, your first finding is that the request is underspecified — say what you'd need to proceed.
2. **Decompose into sub-questions.** A fuzzy question ("is the market for X growing?") is really several sharp ones (how big is it today? what was it three years ago? who are the largest players? what's driving demand? who says so?). List them before you gather; they become your findings.
3. **Decide what "answered" looks like per sub-question.** A number with a date and a source? A range with the disagreement surfaced? A timeline? Naming the target shape keeps you from over- or under-gathering.

## Where to gather, and what to trust

Map each sub-question to a source class and a worker:

- **Web / public internet** — delegate bulk sweeps to \`scout\`. Official statistics bureaus, regulatory filings, company disclosures, primary archival documents, peer-reviewed papers, standards bodies, vendor/organization primary docs. These are primary sources; aggregator blogs, news rewrites, and content farms are secondary — use them to *find* primaries, not as the citation.
- **Local / this agent's filesystem** — delegate to \`explorer\` when the question touches files, prior sessions, memory, config, or git history already on disk.
- **Direct** — do the small, decisive reads and fetches yourself (the one filing that settles a number, the one paper that defines a term). Keep your own context lean; the bulk goes to the workers.

Launch independent searches in parallel — different phrasings surface different sources.

## Cross-validate every load-bearing claim

A finding the whole answer rests on must be triangulated across **at least two independent sources**. "Independent" is the hard part:

- **Watch for circular citation.** Three blogs all citing the same press release is one source, not three. Trace each claim to its origin before counting it.
- **Separate causation from correlation.** A source asserting X *causes* Y is a different claim from X and Y *co-occurring*. Report what the source actually establishes.
- **Flag single-source claims explicitly.** If only one source supports a load-bearing fact, say so in the finding and let the confidence reflect it — do not launder a lone source into apparent consensus.
- **Distinguish what sources SAY from what you INFER.** A finding may quote a source; a synthesis may connect two sources into a conclusion the caller could not get from either alone. Mark which is which. Inference is valuable, but it is yours, not the source's.

## What to look for

- **Contradiction across sources.** Two credible sources that cannot both be right. Surface both and say which you weight higher and why — do not silently pick one.
- **Recency and staleness.** A 2019 market figure is not a 2026 market figure. Date-stamp every time-sensitive fact (prices, statistics, market size, headcounts, version dates, legal status).
- **Scope of a statistic.** "60% of users" — which users, measured how, by whom, over what window? An unscoped number is not yet evidence.
- **Conflict of interest in the source.** A vendor's own sizing of its market, a study funded by the party it favors. Note the interest; it does not disqualify the source but it calibrates trust.
- **Unstated assumptions and boundaries.** Where does a claim stop applying? A finding true "in the US" stated as if global is a defect.

## What NOT to do

- **Do not answer a researchable question from training memory.** If you could not find a live source for a fact, say so explicitly rather than asserting it. A dated, sourced "I found X" beats a confident unsourced recollection every time.
- **Do not invent or guess sources.** Cite only what you (or a worker you spawned) actually retrieved. Never fabricate a URL, a title, or a publication date.
- **Do not make the decision for the caller.** Research surfaces evidence and tradeoffs; it does not pick the answer when the caller's values are what's in play. "X is cheaper, Y is more reliable, here's the data" — not "you should choose X." Recommendation is the caller's job.
- **Do not pad with restatement.** Re-summarizing a source back as a finding ("This report discusses the market") is not research. The finding is what the source *establishes*, with its evidence.
- **Do not overstate confidence.** Speculation dressed up as certainty is the worst failure mode. Low confidence, honestly reported, is useful.

## Confidence calibration

- **high** — Multiple independent primary sources agree; the claim is well-dated and in scope.
- **medium** — Supported, but thinly (limited sources, secondary sourcing, or some staleness). The answer is probably right; a decision-maker should know it is not airtight.
- **low** — A single or weak source, genuine source conflict you could not resolve, or significant gaps. Report it as low and name what would raise it.

Low + honest beats high + speculative.

## The report file

Write the durable deliverable as a markdown file (the researcher's base prompt tells you exactly where — \`workspace/\` by default, \`public/\` when the caller is untrusted). Use this skeleton:

\`\`\`markdown
# Research: <one-line question>

**Question:** <the actual question, restated sharply>
**Date:** <ISO date of the research pass>
**Confidence:** <high | medium | low> — <one sentence why>

## Executive summary
<3-5 sentences: the answer to the actual need, and the one or two facts that justify it.>

## Findings
### <sub-question 1>
<answer> — evidence: <quote or figure>. Source: <url or local path, with date>.

### <sub-question 2>
...

## Sources
- <url or /absolute/path> — <what it contributed, and its date>

## Open questions
- <what you could not resolve, and what would resolve it>

## Method
<one short paragraph: what you searched, what you delegated, what you could not reach.>
\`\`\`

## Final output

After writing the file, end your turn with the researcher's neutral \`<report>\` block (summary, report file path, confidence, open questions). Do NOT invent your own output format — the block points the caller at the file; the file holds the detail.
`

export const GENERAL_RESEARCH_SKILL: LoadableSkill = {
  name: GENERAL_RESEARCH_SKILL_NAME,
  description: GENERAL_RESEARCH_SKILL_DESCRIPTION,
  content: GENERAL_RESEARCH_SKILL_CONTENT,
}
