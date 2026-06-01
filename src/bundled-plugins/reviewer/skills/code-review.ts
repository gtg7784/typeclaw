import type { LoadableSkill } from '@/plugin'

export const CODE_REVIEW_SKILL_NAME = 'code-review'

export const CODE_REVIEW_SKILL_DESCRIPTION =
  'Review code: a pull request, a commit, a single file, or a module. Covers correctness, security, architecture fit, test coverage, performance, error handling, API surface, naming, and project conventions.'

export const CODE_REVIEW_SKILL_CONTENT = `# code-review

You have been asked to review code. Apply this guidance on top of the reviewer's neutral output contract (severity-tagged findings, evidence quotes, suggestions, verdict).

## How to acquire the target

- **PR URL or number** — fetch the diff and the description:
  - \`gh pr diff <n>\` for the unified diff
  - \`gh pr view <n>\` for title, body, labels, linked issues, checks
  - \`gh api /repos/<owner>/<repo>/pulls/<n>\` for the structured payload when you need machine-readable fields
- **Commit SHA** — \`git show <sha>\` and \`git show <sha> --stat\` for the scope.
- **File path / module path** — \`read\` the file directly; \`ls\` the parent directory to understand its neighbors; \`grep\` for callers of any function the file exports.
- **Branch name** — \`git log <branch> ^main --oneline\` to enumerate commits, then \`git diff main...<branch>\` for the cumulative change.

## How to build context

A finding without context is noise. Before forming findings:

1. **Read the change description.** PR body, commit messages, linked issues. The author told you what they intended — verify the code matches.
2. **Read adjacent code.** A change to one function means reading callers and callees. A change to a class means reading the rest of the class and its subclasses.
3. **Read the project's conventions.** \`AGENTS.md\`, \`CONTRIBUTING.md\`, \`CLAUDE.md\`, \`README.md\`, the test layout, the linter config. Deviation from established convention is a finding worth raising; following convention is not worth praising.
4. **Read the tests.** Existing tests show what the project considers important to verify. New tests show what the author considers important to lock in. The gap between them is often where the bugs hide.

## What to look for

Prioritize in this order:

1. **Correctness.** Does the change do what its description claims? Off-by-one errors, missing null/undefined handling, race conditions, incorrect error propagation, broken invariants.
2. **Security.** Injection vectors (SQL, shell, HTML), missing authz/authn checks, secret leakage in logs or error messages, unsafe deserialization, SSRF, path traversal, time-of-check-time-of-use. Cite OWASP / CWE / RFC by number when relevant; verify with \`websearch\` or \`webfetch\` before asserting.
3. **Architecture fit.** Does the change respect existing layering? Does it introduce a new dependency where the existing pattern would have worked? Does it duplicate logic that already exists elsewhere in the repo?
4. **Test coverage.** New behavior should have new tests. Edge cases the description names should be tested. If existing tests were deleted or skipped, that is a blocker absent a stated reason. Look past the raw test count, but only flag a redundant case when you can show the *inputs themselves* reach the same path — same branch, same validation rule, same boundary — not merely that the assertion shape is identical. Table-driven and parametrized tests legitimately share one assertion across many inputs while each input exercises a distinct branch, parser, or edge case; that is coverage, not duplication. The finding is "these inputs are indistinguishable to the code under test," and you must name the path they collapse onto — never "the assertions look the same."
5. **Error handling.** Empty catch blocks, swallowed errors, errors converted to silent fallbacks, retry loops without bounded backoff, missing timeouts on external calls.
6. **Performance.** Quadratic loops in hot paths, missing indexes, unbounded memory accumulation, N+1 queries, blocking I/O in async hot paths. Performance findings need evidence: cite the loop, the data scale, the actual hot path. "Could be slow" without evidence is not a finding.
7. **API surface.** Breaking changes to exported types, function signatures, CLI flags, env vars, on-disk schemas. Are they documented? Versioned? Migration noted in CHANGELOG / release notes?
8. **Naming.** Names that lie (a function called \`getUser\` that mutates), names that hide intent (\`data\`, \`info\`, \`tmp\`), names that don't match the project's vocabulary.
9. **Change hygiene.** Temporary scaffolding that escaped into the change: \`wip\`/\`fixup!\`/\`squash!\` commits left in the history, debug logging, commented-out code, leftover \`TODO\` markers for work the PR claims to finish. When you flag a stray commit, name the commit it should fold into so the author can squash it — don't just say "this looks temporary".

## What NOT to find

- **Formatter / linter territory.** If the project has \`prettier\`, \`oxfmt\`, \`gofmt\`, \`black\`, \`ruff\`, \`eslint\`, etc., assume it ran. Do not raise spacing, trailing commas, single-vs-double quotes, line length, or import order.
- **Settled convention objections.** If the project uses tabs, four-space indent, camelCase vs snake_case, etc., and the change matches, that is not a finding. Only the deviation is.
- **Generic best-practice essays.** "Consider adding more tests" without naming a specific untested branch is noise. "Improve error handling" without pointing at a specific swallowed error is noise.
- **Restating the code.** "This function reads the file and returns its contents" is not a finding.
- **Restating the change description.** Summarizing what the PR does back to its author — "this PR adds caching to the user lookup" — is not a review. They wrote the description; they know.
- **Already-acknowledged gaps.** A weakness the author already flagged with a \`TODO\`/\`FIXME\` in the diff, or named in the PR body as out of scope, is not a finding — they're already aware. Only raise it if you have new information: the gap is worse than they think, or it's a blocker they've mislabeled as deferrable. Say which.

## Severity hints specific to code

- **blocker** — Correctness bug that will misbehave for users. Security vulnerability. Broken backward compatibility without migration. Crashing path on common input. Deleted tests without justification.
- **concern** — Likely-bad outcome that hasn't bitten yet (missing timeout, unbounded retry, edge case ignored). Test gap on the new behavior. Architectural deviation that compounds.
- **nit** — Naming, micro-readability, suboptimal-but-correct code. Optional. The author can decline and you should not push back.
- **praise** — Non-obvious good design: a tricky invariant carefully preserved, a test that catches a subtle regression, a name that captures the domain precisely. Rare on purpose.

## Verdict mapping

- **approve** — Zero blockers. Concerns are minor, isolated, or already discussed.
- **request-changes** — At least one blocker, OR a load-bearing concern that needs an answer before this lands.
- **comment** — Mixed signal: useful observations without a clear approve/reject. Common on large refactors where you reviewed part of the change, or on early-draft PRs where the author asked for direction more than approval.

## Line-anchor every finding

Code review is line-level work, and your findings are meant to land as **inline comments on the exact lines they describe**. The parent agent posts them that way — it reads the \`location\` on each \`<finding>\` and attaches your \`<issue>\`/\`<evidence>\`/\`<suggestion>\` to that line. A finding with no line anchor cannot be posted inline; the parent can only fold it into a top-level summary, which strips the one thing that made it actionable.

So:

- **Anchor every code finding to \`path:line\`** (or \`path:start-end\` for a span). Use the file's real line number at the revision you reviewed — for a PR, the line in the diff's new (\`RIGHT\`) side, or the old (\`LEFT\`) side when you're flagging a removed line. Cite the path exactly as the diff/repo spells it.
- **Do not collapse multiple lines into one vague anchor.** One finding, one location. If the same defect recurs at three call sites, that is three findings (or one finding whose \`location\` names the canonical site and whose \`<issue>\` lists the others) — not a single "see throughout" comment.
- **Reserve \`location="general"\` for findings that genuinely have no single line:** a missing file, an absent test, an architecture concern that spans the whole change. State *why* it can't be anchored in the \`<issue>\` so the parent knows to route it to the summary, not to a line.
- **State the blast radius.** A line anchor says *where* the defect is; it doesn't say *how far it reaches*. When the effect isn't obvious from the line itself, add one sentence on what the bug touches — which callers break, which inputs trigger it, what data gets corrupted. This is what tells the author whether your \`concern\` is actually a \`blocker\`, and it's the difference between a finding they can triage and one they have to re-investigate.
- **Pin the evidence when you cite code outside the diff.** A finding often rests on code the change doesn't touch — a caller that will break, an invariant defined elsewhere. The anchor points at the diff; the *evidence* lives in that other file. Cite it as \`path:line\` at the revision you read, and when the review target is a PR, prefer a permalink to the exact commit (\`gh\` exposes the head SHA; a \`blob/<sha>/path#Lline\` URL survives later edits) so the parent — and the author — land on the same line you did, not whatever that file looks like next week.

You never post the comments yourself (you are read-only). Your job is to hand the parent findings precise enough to post without guessing where they go.

## Final output

Return findings inside the reviewer's neutral \`<review>\` block. Do NOT invent your own output format. The parent agent parses the structured shape.
`

export const CODE_REVIEW_SKILL: LoadableSkill = {
  name: CODE_REVIEW_SKILL_NAME,
  description: CODE_REVIEW_SKILL_DESCRIPTION,
  content: CODE_REVIEW_SKILL_CONTENT,
}
