import type { LoadableSkill } from '@/plugin'

export const CODE_REVIEW_SKILL_NAME = 'code-review'

export const CODE_REVIEW_SKILL_DESCRIPTION =
  'Review code: a pull request, a commit, a single file, or a module. Covers correctness, security, architecture fit, test coverage, performance, error handling, API surface, naming, project conventions, and the PR title/body itself as a record — whether it captures the why behind each change for future readers.'

export const CODE_REVIEW_SKILL_CONTENT = `# code-review

You have been asked to review code. Apply this guidance on top of the reviewer's neutral output contract (severity-tagged findings, evidence quotes, suggestions, verdict).

## How to acquire the target

- **PR URL or number** — fetch the diff and the description:
  - \`gh pr diff <n>\` for the unified diff
  - \`gh pr view <n> --json title,body,baseRefName,headRefOid,files\` for title, body, linked issues, the head SHA, and the changed-file list
  - \`gh api /repos/<owner>/<repo>/pulls/<n>\` for the structured payload when you need machine-readable fields
- **Commit SHA** — \`git show <sha>\` and \`git show <sha> --stat\` for the scope.
- **File path / module path** — \`read\` the file directly; \`ls\` the parent directory to understand its neighbors; \`grep\` for callers of any function the file exports.
- **Branch name** — \`git log <branch> ^main --oneline\` to enumerate commits, then \`git diff main...<branch>\` for the cumulative change.

### Your cwd is NOT the PR's repo — read at the head SHA

You run in the agent folder (\`/agent\`), **not** a checkout of the PR's target repository. A bare \`read /agent/src/...\` for a file that lives in the PR's repo will fail with \`ENOENT\` — the file is not on this disk. **When \`read\` returns \`ENOENT\` for a path you expected to exist, stop retrying local reads immediately**: that is the signal you are outside the target checkout, not a transient miss. Switch to one of the two acquisition modes below. Do not burn turns re-issuing \`read\` against \`/agent\` paths that will never resolve.

Whichever mode you use, **every line number you cite must come from the PR's head SHA** (\`headRefOid\` from \`gh pr view\`), not the default branch — inline comments anchor to that exact revision.

**Mode 1 — remote-read (default, for a handful of files).** When you need only a few adjacent files, fetch each **once** at the head SHA. Prefer \`gh api\` over \`raw.githubusercontent.com\`: \`gh api\` carries the adapter's GitHub auth, so it works on private repos too.

A repo-targeting \`gh\` command MUST be a **single bare \`gh\` invocation** — no pipes, \`&&\`, \`;\`, or redirects. The runtime injects the GitHub App token into the command's environment, so any sibling stage in a pipeline would inherit a live token; the guard blocks those shapes (the same rule the GitHub channel skill enforces for review posting). So do NOT pipe \`gh api ... | base64 -d | nl -ba\` — that exact shape is rejected before it runs. Instead fetch the **already-decoded** file with the raw media type in one bare call:

\`\`\`sh
gh api "/repos/<owner>/<repo>/contents/<path>?ref=<headSha>" -H "Accept: application/vnd.github.raw"
\`\`\`

That returns the file's raw bytes (no base64, no second stage). For the line numbers your \`location="path:line"\` anchors need, read them off the unified diff you already fetched (\`gh pr diff\` prints the new-side line numbers in its hunk headers, \`@@ -a,b +c,d @@\`), or escalate to Mode 2 where a real \`read\`/\`grep\` gives native line numbers. Fetch each file once and keep its output — do not re-fetch the same file to re-derive a line you already saw.

**Mode 2 — scratch checkout (escalate when navigation gets broad).** When the review needs repo-wide \`grep\`, symbol tracing across several directories, many adjacent files, or repeated access to the same files, the remote-read dance is slower and more error-prone than a real checkout. In that case clone the PR head into a **fresh throwaway directory under \`/tmp\`** and read it natively:

\`\`\`sh
git clone --depth 1 "https://github.com/<owner>/<repo>.git" /tmp/review-<n>-src && \
  git -C /tmp/review-<n>-src fetch --depth 1 origin <headSha> && git -C /tmp/review-<n>-src checkout <headSha>
\`\`\`

Then \`read\`, \`grep\`, \`find\`, and read-only \`git\` (\`git -C /tmp/review-<n>-src log|diff|show|blame|grep|ls-files|cat-file\`) all work against \`/tmp/review-<n>-src\` with correct line numbers and zero per-file round-trips.

This \`/tmp\` scratch checkout is the **one** write the read-only contract permits — and only because it is a private acquisition cache, never the reviewed artifact. Inside it you may only **read**. You still may NOT: edit any file, install dependencies, run builds or tests, commit/stage/push/rebase/reset, or write anywhere outside this \`/tmp\` scratch dir. Do not \`rm\` it when done — leave cleanup to the session lifecycle (\`rm\` stays forbidden). When in doubt about how many files you'll touch, start with Mode 1 and escalate to Mode 2 only once the file count or grep breadth justifies the clone.

## How to build context

A finding without context is noise. Before forming findings:

1. **Read the change description.** PR body, commit messages, linked issues. The author told you what they intended — verify the code matches.
2. **Read adjacent code.** A change to one function means reading callers and callees. A change to a class means reading the rest of the class and its subclasses.
3. **Read the project's conventions.** \`AGENTS.md\`, \`CONTRIBUTING.md\`, \`CLAUDE.md\`, \`README.md\`, the test layout, the linter config. Deviation from established convention is a finding worth raising; following convention is not worth praising.
4. **Read the tests.** Existing tests show what the project considers important to verify. New tests show what the author considers important to lock in. The gap between them is often where the bugs hide.

## Review the PR title and body as an artifact, not just as context

Steps above use the PR title and body as *input* — the author's stated intent, which you check the code against. But the description is also a **deliverable in its own right, and it is part of your review scope.** Most harnesses only diff code and never review the prose; you are the one pass that can, so treat the title and body as a first-class review target alongside the diff.

Why this matters — the frame that decides your findings here:

- **A PR is a record, not a showcase.** Its dominant purpose is not to display the code or even to solicit code review — it is to **record the translation from the business need into the code change**: *why* this change became necessary, what business or product context forced it, what decision was made and what was rejected. The code shows *what* changed; the body is the only place *why* survives. When the why is absent, it is gone the moment the author forgets it.
- **The audience is the reviewer and future-self, who do NOT share the author's context.** The current reviewer, a teammate six months from now, or the author themselves later, all read this record under real cognitive load, missing the context that was obvious the day it was written. A good body exists to *lower that load*. Judge the body by whether a reader without the author's head can reconstruct why each change was made.
- **The concrete failure is a change whose context is silently dropped.** A large task drags in incidental side changes; the low-importance ones lose their rationale first, and later someone does redundant or wrong work because the record never explained the earlier decision (e.g. a field added in one PR with no note that it duplicates an existing one, so a later PR "fixes" a problem that was actually intentional). This is the highest-value thing to catch: a change in the diff that the body leaves **unexplained or unconnected to its reason**.

What to look for in the title and body:

1. **Rationale for every meaningful change, not just the headline one.** The primary change is usually explained. The finding is the *secondary* change — a schema tweak, a config flip, a "while I was here" refactor, a new field — that appears in the diff with no corresponding why in the body. Anchor the finding to the diff hunk whose rationale is missing, and name what a future reader would fail to reconstruct.
2. **Title accuracy and scope match.** Does the title name what the change actually does? Does the body's described scope match the diff — nothing significant in the diff that the body never mentions, and nothing promised in the body that the diff never delivers? A title that says A while the diff also does B is a scope/record defect: the B change is now unfindable by anyone searching the history for it.
3. **Meaning-unit separation.** When the diff bundles several unrelated logical changes under one description, the context for each is harder to recover and the record is degraded even if every line is correct. Flag it as a record problem — the fix may be to split the PR, or at minimum to give each logical unit its own explained section in the body — not as a code defect.
4. **Decision and trade-off capture.** For a change that chose one approach over an obvious alternative, or that is a deliberate one-way door (schema, public API, migration), does the body record the decision and why? A silent irreversible decision is a record gap worth raising even when the code is correct.
5. **Linked context integrity.** Referenced issues/tickets/prior PRs actually correspond to this change; a load-bearing claim in the body ("as decided in #123") points where it says it does. A dangling or wrong reference breaks the record's chain.

Keep the anti-noise line from below firmly in view: **do not confuse restating the description with reviewing it.** Summarizing what the PR does back to the author is noise (see "What NOT to find"). The review work here is the *gap* — a change with no recorded reason, a title that misleads, a bundled scope that buries context, a decision left unexplained. Anchor these to the specific diff hunk or the quoted body passage; use \`location="general"\` only for a whole-description defect (e.g. an empty body on a non-trivial change) and say why in the \`<issue>\`. Calibrate severity to consequence, not to prose taste: an unexplained behavior-changing hunk or a title that hides a real change is a \`concern\` (a \`blocker\` when the missing context is what stops a future reader from avoiding a concrete mistake); a thin-but-adequate body is at most a \`nit\`. A body's writing quality is not the target — its function as a record is.

## What to look for

Prioritize in this order:

1. **Correctness.** Does the change do what its description claims? Off-by-one errors, missing null/undefined handling, race conditions, incorrect error propagation, broken invariants.
2. **Security.** Injection vectors (SQL, shell, HTML), missing authz/authn checks, secret leakage in logs or error messages, unsafe deserialization, SSRF, path traversal, time-of-check-time-of-use. Cite OWASP / CWE / RFC by number when relevant; verify with \`web_search\` or \`web_fetch\` before asserting.
3. **Architecture fit and intent drift.** Does the change respect existing layering? Does it introduce a new dependency where the existing pattern would have worked? Does it duplicate logic that already exists elsewhere in the repo? Beyond local fit, check for **intent drift** — the change technically compiles and passes its own tests, but quietly diverges from the design intent the surrounding code was built on: a "temporary" branch that bypasses an established abstraction, a special-case that erodes an invariant the module exists to protect, a layer reaching past its boundary because that was the shortest path. The diff can be locally correct and still pull the system away from the shape the author (or the codebase's own conventions) intended. When the description states an intent — "without changing the public API", "purely a refactor", "no behavior change" — verify the diff actually holds that line; a refactor that alters observable behavior, or an "internal only" change that shifts an exported contract, is drift even if nothing is strictly broken. Anchor the finding to the line where the divergence enters and name the intent it violates.
4. **Regression risk and blast radius.** A change is rarely self-contained. For every function signature, return shape, exported type, default value, thrown-error type, or side-effecting behavior the diff alters, ask **who depended on the old behavior**. \`grep\` for callers of changed exports; trace the call sites that touch a modified invariant. A contract change that is correct *here* can silently break a caller the diff never shows — that caller is the regression, and it will not appear in the test count for this PR. Removed or loosened validation, a narrowed accepted-input range, a changed enum value, an altered ordering guarantee, a default that flipped: each is a regression vector for existing consumers even when the new code reads fine in isolation. State the blast radius explicitly — which call sites, which inputs, which downstream behavior changes — so the author knows whether this is a \`concern\` or a \`blocker\`. "Looks fine in the diff" is not a regression clearance; the diff is exactly where regressions hide their other half.
5. **Side effects and ripple.** Watch for effects that reach outside the lines being changed: mutation of shared or global state, a cache that now needs invalidating, an event/log/metric whose shape downstream consumers parse, a config or feature flag whose new value changes behavior elsewhere, a migration that must run in lockstep, a resource (file handle, connection, lock, subscription) opened on a new path and never released. The dangerous side effect is the one whose *consequence* isn't obvious from the changed line alone — a behavior that emerges from the interaction between the changed code and code it touches indirectly. There is still a line that introduces it: anchor the finding to the mutation, lifecycle, or config line where the ripple enters, then name the downstream consumer or shared state that breaks and say what goes wrong when it is not accounted for. If the change touches a shared resource's lifecycle, verify the cleanup path (\`finally\`, \`defer\`, \`using\`, teardown hook) covers the new branch too — a leak introduced on an error path is a side effect that only shows up under load.
6. **Test coverage.** New behavior should have new tests. Edge cases the description names should be tested. If existing tests were deleted or skipped, that is a blocker absent a stated reason. Look past the raw test count, but only flag a redundant case when you can show the *inputs themselves* reach the same path — same branch, same validation rule, same boundary — not merely that the assertion shape is identical. Table-driven and parametrized tests legitimately share one assertion across many inputs while each input exercises a distinct branch, parser, or edge case; that is coverage, not duplication. The finding is "these inputs are indistinguishable to the code under test," and you must name the path they collapse onto — never "the assertions look the same."
7. **Error handling.** Empty catch blocks, swallowed errors, errors converted to silent fallbacks, retry loops without bounded backoff, missing timeouts on external calls.
8. **Performance.** Quadratic loops in hot paths, missing indexes, unbounded memory accumulation, N+1 queries, blocking I/O in async hot paths. Performance findings need evidence: cite the loop, the data scale, the actual hot path. "Could be slow" without evidence is not a finding.
9. **API surface.** Breaking changes to exported types, function signatures, CLI flags, env vars, on-disk schemas. Are they documented? Versioned? Migration noted in CHANGELOG / release notes?
10. **Naming.** Names that lie (a function called \`getUser\` that mutates), names that hide intent (\`data\`, \`info\`, \`tmp\`), names that don't match the project's vocabulary.
11. **Change hygiene.** Temporary scaffolding that escaped into the change: \`wip\`/\`fixup!\`/\`squash!\` commits left in the history, debug logging, commented-out code, leftover \`TODO\` markers for work the PR claims to finish. When you flag a stray commit, name the commit it should fold into so the author can squash it — don't just say "this looks temporary".

## What NOT to find

- **Formatter / linter territory.** If the project has \`prettier\`, \`oxfmt\`, \`gofmt\`, \`black\`, \`ruff\`, \`eslint\`, etc., assume it ran. Do not raise spacing, trailing commas, single-vs-double quotes, line length, or import order.
- **Settled convention objections.** If the project uses tabs, four-space indent, camelCase vs snake_case, etc., and the change matches, that is not a finding. Only the deviation is.
- **Generic best-practice essays.** "Consider adding more tests" without naming a specific untested branch is noise. "Improve error handling" without pointing at a specific swallowed error is noise.
- **Restating the code.** "This function reads the file and returns its contents" is not a finding.
- **Restating the change description.** Summarizing what the PR does back to its author — "this PR adds caching to the user lookup" — is not a review. They wrote the description; they know. (This forbids *echoing* the body, not *reviewing* it: judging whether the body records the why, matches the diff, and separates its meaning units is in scope — see "Review the PR title and body as an artifact". The line is echo vs. evaluate.)
- **Already-acknowledged gaps.** A weakness the author already flagged with a \`TODO\`/\`FIXME\` in the diff, or named in the PR body as out of scope, is not a finding — they're already aware. Only raise it if you have new information: the gap is worse than they think, or it's a blocker they've mislabeled as deferrable. Say which.

## Severity hints specific to code

- **blocker** — Correctness bug that will misbehave for users. Security vulnerability. Broken backward compatibility without migration. Crashing path on common input. Deleted tests without justification. A regression that breaks an existing caller you can name, or a side effect (leaked resource, un-invalidated cache, mutated shared state) that corrupts behavior outside the diff.
- **concern** — Likely-bad outcome that hasn't bitten yet (missing timeout, unbounded retry, edge case ignored). Test gap on the new behavior. Architectural deviation or intent drift that compounds. A plausible regression or side effect whose reach you suspect but cannot fully trace — say what you'd check to confirm, and let the blast radius decide whether it's really a blocker.
- **nit** — Naming, micro-readability, suboptimal-but-correct code. Optional. The author can decline and you should not push back.
- **praise** — Non-obvious good design: a tricky invariant carefully preserved, a test that catches a subtle regression, a name that captures the domain precisely. Rare on purpose.

## Verdict mapping

- **approve** — Zero blockers. Concerns are minor, isolated, or already discussed.
- **request-changes** — At least one blocker, OR a load-bearing concern that needs an answer before this lands.
- **comment** — Mixed signal: useful observations without a clear approve/reject. Common on large refactors where you reviewed part of the change, or on early-draft PRs where the author asked for direction more than approval.

### Re-reviews must re-decide, not observe

When the payload tells you this is a **re-review** — you (or this agent) previously requested changes on this PR and the author has pushed fixes — your verdict's whole purpose is to **re-decide the blocking state**, so:

This includes payloads where the parent says the author **addressed your prior blocking feedback** — "fixed both issues", "addressed your review", "pushed a fix" — even when the inbound was phrased conversationally rather than as an explicit "review again". An author responding to the blocker you raised IS the re-review trigger; the absence of the words "review again" does not downgrade it to a \`comment\`. Re-decide:

- Return **approve** if the blockers that drove the prior \`request-changes\` are resolved (leftover nits do not block — \`approve\` with inline nits is correct).
- Return **request-changes** if any blocker remains or a new one appeared.

**Account for resolved threads in the \`<summary>\`, not as \`praise\` findings.** A re-review tempts you to emit one \`praise\` finding per prior concern the author fixed — "Thread 123 is addressed", "Thread 456 is addressed". Do **not**. \`praise\` is reserved for *non-obvious good work*, and a routine "you fixed what I asked" is neither non-obvious nor a finding the parent should post inline (it strips \`praise\` from inline comments anyway, so these become dead weight). Instead, state the resolution accounting in one sentence in your \`<summary>\` — e.g. "Both prior blockers (the unfenced table scan and the backtick-wrap span) are resolved at head \`<sha>\`; one new concern below." Reserve actual \`<finding>\` entries for what still needs action: a prior blocker that is **only partially** fixed (\`blocker\`/\`concern\`, anchored to the line that's still wrong), a **regression the fix introduced** (\`blocker\`/\`concern\`), or a genuinely non-obvious fix worth a rare \`praise\`. A clean re-review where everything was addressed is an \`approve\` whose \`<summary>\` says so and whose \`<findings>\` is empty — not a wall of \`praise\` receipts.
- **Do NOT return \`comment\` on a re-review.** \`comment\` is for ambiguous partial reviews with no accept/reject signal; a re-review is the opposite — it is precisely an accept/reject decision. A \`comment\` verdict here leaves the PR's \`REQUEST_CHANGES\` state stuck (a plain comment does not clear it on GitHub), which is the exact failure a re-review exists to resolve. The only escape hatch is the same one that always applies: if you genuinely cannot reach the diff or the prior context, return one \`blocker\` finding stating what you need and a \`comment\` verdict — but a reachable, reviewable re-review must end in \`approve\` or \`request-changes\`.

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
