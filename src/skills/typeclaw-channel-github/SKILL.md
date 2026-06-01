---
name: typeclaw-channel-github
description: Use this skill BEFORE every `channel_reply` or `channel_send` call whose adapter is `github`, AND before composing replies to GitHub-originated inbounds, AND before opening new issues or PRs with `gh`, AND ALWAYS when you are asked to review a PR — whether the inbound says "requested your review on PR #N" / "requested a review from team @… on PR #N", or a human asks for a review in plain language in an issue/PR body or comment ("@bot review this", "can you take a look at #123"). On a review request you delegate the analysis to the `reviewer` subagent, which produces line-anchored findings, then you post them as an inline review via `gh api`. GitHub renders **real markdown** — `**bold**`, `## headings`, `| tables |`, fenced code blocks, and `inline code` all render natively. Use rich markdown freely. GitHub cannot send file attachments via API — do not call `channel_send` with attachments on github chats. GitHub has no typing indicator. PR review threads use `thread` keyed on the root comment id; reply to a thread to stay in it, or omit `thread` to post a top-level issue/PR comment. When a review comment **you authored** gets addressed — the author pushed a fix or replied that resolves it — verify the fix at the PR's head SHA and then resolve the thread with the `resolveReviewThread` GraphQL mutation (see "Resolving review threads you authored" below); resolving is the close-out that tells the author the concern is settled. To open new issues or PRs use the `gh` CLI — `GH_TOKEN` is pre-set by the adapter. Read this skill before composing anything on GitHub.
---

GitHub renders normal Markdown in issues, PRs, discussions, and review comments. Use headings, lists, tables, fenced code blocks, links, and inline code when they improve clarity.

- Do not send attachments on GitHub chats; the adapter rejects them.
- There is no typing indicator.
- For PR review threads, keep `thread` set to reply in-place. Omit `thread` for a top-level PR/issue comment.
- When a review comment **you authored** has been addressed, resolve its thread — see "Resolving review threads you authored" below. The base principle is **whoever opened the thread closes it**: you resolve only the threads you started, never a human's.

## Mid-turn status replies need `continue: true`

A successful `channel_reply` ends your turn by default — the runtime stops the model right after the reply lands. That is correct for a final answer, but it will **silently truncate** a turn that still has work to do. If you post a status line like "Reviewing now, I'll be back with findings" and then expect to keep working (fetch the diff, spawn the reviewer, post the review) in the **same** turn, you must call `channel_reply({ text: "…", continue: true })`. Without `continue: true`, the turn ends at that status reply and the review never runs. Reserve `continue: true` for genuine multi-step turns; the final reply that wraps up the turn omits it.

## What to do, by inbound type

Every GitHub inbound lands on a `chat` keyed by its subject: `issue:N`, `pr:N`, or `discussion:N`. Pick your action from the kind of thing that arrived. The default action for anything addressed to you is a normal `channel_reply` in that thread; the **PR review flow** below is the one exception that requires delegation.

| Inbound                                                  | Looks like                                                                           | What to do                                                                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **New issue** (`issue:N`)                                | A freshly opened issue body.                                                         | Triage or answer it. `channel_reply` on `issue:N`. Open follow-up issues/PRs with `gh` if needed.                                                 |
| **Issue comment** (`issue:N`)                            | A comment on an issue.                                                               | Reply in the issue thread with `channel_reply`.                                                                                                   |
| **PR conversation comment** (`pr:N`, no `thread`)        | A comment on a PR's main conversation (GitHub models PR comments as issue comments). | Reply on the PR with `channel_reply`. **If the text asks you to review → go to the PR review flow.**                                              |
| **PR review-thread reply** (`pr:N`, `thread` set)        | A reply on an existing inline review comment thread.                                 | Stay in the thread: `channel_reply` with `thread` kept as-is. **If it addresses a comment you authored → verify and resolve the thread (below).** |
| **A submitted review** (`pr:N`)                          | Someone submitted a formal review (approve / changes / comment) on a PR.             | React if a response is warranted (answer a question, acknowledge changes). `channel_reply` on `pr:N`.                                             |
| **New discussion / discussion comment** (`discussion:N`) | A discussion thread or a comment in one.                                             | Reply with `channel_reply` on `discussion:N`.                                                                                                     |
| **Review requested** (`pr:N`)                            | See "When you are being asked to review" below.                                      | **PR review flow.**                                                                                                                               |

### When you are being asked to review

You are being asked to review a PR in **either** of these cases — treat them identically:

- **(A) An explicit review-request inbound.** The message text says **"requested your review on PR #N"** or **"requested a review from team @… on PR #N"**. (You do not need to know how it was triggered — the adapter synthesizes this same text whether a human requested you as a reviewer directly or requested a decoy user account that impersonates you as a GitHub App. From your side it reads the same. See [GitHub decoy reviewer](/docs/internals/github-decoy-reviewer).)
- **(B) A human asks you to review in plain language** in a PR/issue body or any comment — "@bot review this PR", "can you take a look at #123", "review the changes when you get a chance". There is no synthetic request text here; you recognize the intent from the message.

Both → run the **PR review flow**. Do not review inline yourself and do not just reply with prose impressions: delegate to the `reviewer` subagent so the analysis runs on the `deep` model, then post its findings as an inline review.

A `review_request_removed` inbound ("removed your review request on PR #N") is the inverse: the requester un-assigned you. Cancel any in-flight reviewer subagent (`subagent_cancel`) and do not post a partial review.

## PR review flow

The `reviewer` subagent is the analyst; you are the integration layer between its output and GitHub's review API. It loads the `code-review` skill on demand and returns line-anchored findings inside a `<review>` block. Your job is mechanics: spawn, wait, translate, post.

1. **Confirm the target.** Capture the PR number, the repo, and the head SHA — you may need the SHA to read files at the revision the reviewer analyzed.

   ```sh
   gh pr view <N> --repo owner/repo --json title,body,baseRefName,headRefOid,files
   ```

2. **Spawn the `reviewer` subagent with the PR target.** Use `run_in_background: true` so you stay responsive while the deep model works. Pass the PR URL (or `owner/repo#N`) plus any context the requester gave you (focus areas, specific files, etc.). The reviewer fetches the diff itself (`gh pr diff`, `gh api /repos/.../pulls/<n>`), loads the `code-review` skill, and returns a `<review>` block whose code findings carry `location="path:line"`.

   Do **not** post an "on it" acknowledgement comment before spawning the reviewer — the runtime already adds an :eyes: reaction to the PR the moment it engages, so a "looking into this" comment is redundant noise. Just spawn the reviewer with `run_in_background: true` and keep working; the formal review is your reply. If you want to acknowledge explicitly, use `channel_react({ emoji: "eyes" })`, which reacts without posting a comment.

3. **Wait for the completion `<system-reminder>`,** then call `subagent_output({ task_id })` to read the reviewer's final assistant message. The structured payload looks like:

   ```xml
   <review>
   <summary>...</summary>
   <findings>
     <finding severity="blocker|concern|nit|praise" location="path:line">
       <issue>...</issue>
       <evidence>...</evidence>
       <suggestion>...</suggestion>
     </finding>
   </findings>
   <verdict>approve | request-changes | comment</verdict>
   </review>
   ```

4. **Translate findings into a `gh api` review payload.** Each `<finding>` with `severity` of `blocker`, `concern`, or `nit` and a `location="path:line"` becomes one entry in `comments[]`. Compose the inline `body` from the reviewer's `<issue>` + `<evidence>` + `<suggestion>` verbatim (modulo markdown). Findings whose `location` is `general` (no file:line anchor) go into the top-level review `body` instead. **Skip `praise` findings when building `comments[]`** — if you want to surface them, weave them into the top-level `body`.

   **The verdict and the inline comments are independent. The verdict sets only the `event` field; it never decides whether you post `comments[]`.** Whenever there is at least one actionable finding (`blocker`/`concern`/`nit`) with a `location="path:line"`, you MUST submit a formal review via `POST /pulls/<N>/reviews` carrying those findings in `comments[]` — including when the verdict is `approve`. An `approve` with three nits is still a formal `APPROVE` review with three inline comments, **not** a plain approval and **not** a flattened summary. Collapsing inline findings into a single `channel_reply` or issue comment loses the line anchors the reviewer worked to produce.

   Map the reviewer's `<verdict>` to the GitHub `event`, and trust it — do not upgrade `comment` → `APPROVE` to seem agreeable, or downgrade `request-changes` → `COMMENT` to soften the tone:

   | Reviewer verdict  | GitHub `event`    |
   | ----------------- | ----------------- |
   | `approve`         | `APPROVE`         |
   | `request-changes` | `REQUEST_CHANGES` |
   | `comment`         | `COMMENT`         |

   **Operator approval policy.** If the inbound carries a note that PR approval is disabled (`channels.github.review.approve: false` — the adapter appends "Operator policy: PR approval is disabled for this agent" to the message), you must **not** submit an `APPROVE`. Map an `approve` verdict to `COMMENT` instead: post the same `<summary>` and all inline `comments[]` as a `COMMENT` review, just without the formal approval. `request-changes` and `comment` verdicts are unaffected (they never approve). Absent that note, approval is enabled and the table above applies unchanged.

   Then submit the review. **Write the JSON payload to a file with the `write` tool, then run a single bare `gh api --input <file>`** — two steps:

   First write `/tmp/review.json` (via the `write` tool, not bash):

   ```json
   {
     "event": "COMMENT",
     "body": "<reviewer's <summary> goes here>",
     "comments": [
       {
         "path": "src/foo.ts",
         "line": 42,
         "side": "RIGHT",
         "body": "<issue + evidence + suggestion from the reviewer's finding>"
       },
       { "path": "src/bar.ts", "line": 10, "side": "RIGHT", "body": "..." }
     ]
   }
   ```

   Then post it:

   ```sh
   gh api -X POST /repos/owner/repo/pulls/<N>/reviews --input /tmp/review.json
   ```

   **A repo-targeting `gh` command must be a single bare `gh` invocation — no pipes, `;`, `&&`, heredocs, or command substitution.** The `github-cli-auth` plugin injects the GitHub App token into the command's environment, so any sibling/upstream stage in a pipeline would inherit a live token; the runtime blocks those shapes. That is why the old `cat <<'JSON' | gh api --input -` heredoc-pipe no longer works: write the JSON to a file and feed it with `--input <file>` instead. Do **not** use `-f body=...` or `-F 'comments[][body]=...'`: those go through shell argument parsing, so backticks trigger command substitution. The file passes the JSON through untouched — backticks, newlines, and `${...}` all survive verbatim. The same file-then-`--input` pattern applies to any `gh api` POST whose body contains backticks, embedded newlines, or shell metacharacters.

   Anchor mechanics: `line` is a line number **in the file**, not a position in the diff. `side: RIGHT` is the new revision (default for additions); `side: LEFT` is the old revision (use for comments on removed lines). For multi-line comments, also set `start_line` and `start_side` (same semantics). If you need to read whole files at the PR's head SHA to validate an anchor before posting, use `gh api /repos/owner/repo/contents/<path>?ref=<headRefOid>`.

5. **Verify the review actually landed before announcing it.** The `gh api` call can fail silently from the model's perspective — a permission denial, a bad `line` anchor, or a malformed payload returns an error you must not paper over. After submitting, confirm the review exists:

   ```sh
   gh api /repos/owner/repo/pulls/<N>/reviews --jq '.[-1] | {id, state, user: .user.login}'
   ```

   The returned `id`/`state` is your proof the formal review posted. If the call errored or the review is absent, do **not** fall back to a top-level `channel_reply` that _claims_ a review was posted — fix the payload (most often a `line` that isn't part of the diff; re-anchor it or move that finding to the top-level `body`) and resubmit. A trace reply that says "Posted review" when no review exists is worse than silence.

6. **The decoy reviewer is dropped for you — no action needed.** Under **GitHub App** auth, the adapter automatically removes the decoy reviewer from the PR's requested-reviewers list the moment your formal review lands (it reacts to your own `pull_request_review.submitted` webhook). Why this matters: GitHub auto-adds **you** (the App account) to the PR's reviewers when your review posts, but the **decoy** account would otherwise stay pinned as a perpetual "review requested", as if the review never happened. You do **not** need to issue a `DELETE /requested_reviewers` yourself — and you should not, since it would race the adapter's own cleanup. The removal is self-loop-safe: the adapter's `DELETE` is authenticated as the App, so the `review_request_removed` webhook carries your bot actor (`slug[bot]`) as `sender`, which the classifier drops (see "Self-loop safety" below). This is a no-op under **PAT** auth (no decoy) and for **plain-language**/**team** requests (no decoy user was placed). See [GitHub decoy reviewer](/docs/internals/github-decoy-reviewer).

7. **End the turn with `skip_response`, not a trace reply.** The formal review from step 4 already landed _in this PR_ — it carries the summary, the verdict, and the inline comments. A `channel_reply` here does **not** go to a separate operator channel; on GitHub it posts another public comment on the same PR. A one-line "Posted review on PR #N: …" narrated into the PR thread is meta-commentary addressed to a phantom operator, and it reads absurdly next to the review it claims to point at. So once step 5 confirms the review exists, call `skip_response({ reason: "review posted via gh api" })` to close the turn silently. Only fall back to `channel_reply` when there was **no** formal review to post — the zero-actionable-findings branch below uses `channel_reply`/issue comments _as_ the substantive reply.

### Zero actionable findings

A finding is "actionable" if its severity is `blocker`, `concern`, or `nit`. The inline-review post in step 4 applies whenever the actionable count is **at least one**. When the reviewer returns **exactly zero** actionable findings (only `praise`, or none), there is nothing to anchor inline — handle by verdict:

- `approve` → post a plain `APPROVE` with the `<summary>` as the review body (no `comments[]` array). **If the operator approval policy above disabled approval, submit a `COMMENT` review instead — same `<summary>` as the review body, `event: "COMMENT"`, no `comments[]` array. Keep it a formal review, not a top-level issue comment, so the review metadata and flow are preserved.**
- `comment` → post the summary as a top-level PR comment via `gh api -X POST /repos/.../issues/<N>/comments` instead of submitting an empty review.
- `request-changes` → submit `REQUEST_CHANGES` with the `<summary>` as the review body and no `comments[]` array. This combination is rare (the reviewer's contract says `request-changes` requires at least one blocker or load-bearing concern); if it happens, faithfully encode the verdict and trust the reviewer's reasoning is in the summary.

The bundled `agent-browser` is **not** for PR reviews — `gh api` is faster and more reliable. Only use the browser when the API genuinely can't reach what you need.

## Resolving review threads you authored

A review you posted leaves inline comment threads open on the PR. When one of **your** threads is addressed — the author pushed a fix, or replied that they handled it — close it out by **resolving the thread**. Leaving it open after the concern is settled reads as if you never noticed; a resolved thread is the signal that the loop is closed.

**The base principle: whoever opened the thread closes it.** Resolve only threads whose root comment **you** authored. Never resolve a human reviewer's thread on your behalf — that erases their open question. The thread you can resolve is the one you started; the inbound that brings you here is a **review-thread reply on `pr:N` with `thread` set**, replying inside a thread you opened.

### When a thread counts as addressed

Do not resolve on a bare "done" claim. A reply that says "fixed" is a prompt to check, not proof. Before resolving, **verify the fix at the PR's current head SHA**:

1. Re-read the PR head: `gh pr view <N> --repo owner/repo --json headRefOid` gives you the SHA the author's latest push landed on.
2. Read the lines your comment anchored to, at that SHA: `gh api /repos/owner/repo/contents/<path>?ref=<headRefOid>` (or `gh pr diff <N>` to see what the new push changed). Confirm the change actually addresses the concern your comment raised — not a different line, not a partial fix.
3. Only when the code at head genuinely resolves the finding do you resolve the thread. If the fix is partial or misses the point, **reply in the thread** explaining what's still open and leave it unresolved.

If the author merely **replied** without pushing (e.g. "this is intentional because …") and their reasoning settles it, that is also "addressed" — resolve and, if useful, leave a one-line acknowledgement first. If their reasoning does **not** settle it, keep the thread open and answer.

### How to resolve — `resolveReviewThread` GraphQL mutation

There is no REST endpoint for this. Resolution is a GraphQL mutation that takes the thread's **node id** (`PRRT_…`), not the comment's numeric id. Two steps: find the thread id, then resolve it.

1. **Find the node id of the thread you authored.** Query the PR's review threads and pick the one whose root comment is yours and matches the `thread` you're replying in:

   ```sh
   gh api graphql -f query='query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{id isResolved comments(first:1){nodes{databaseId author{login}}}}}}}}' -F owner=OWNER -F name=REPO -F number=N
   ```

   Match on the root comment: its `comments.nodes[0].databaseId` equals the root comment id (the `thread` value the inbound carried), and `author.login` is you. Skip threads already `isResolved: true`.

   **Paginate until you find the match — `first:100` is one page, not all threads.** A busy PR can carry more than 100 review threads, and yours may sit past the first page; stopping at page one would silently miss it and leave your thread open. Omit `-F after=…` on the first call, then while `pageInfo.hasNextPage` is true and you have not yet matched the `databaseId`, re-run the same query with `-F after=<endCursor>` from the previous page. Stop the moment the target thread is found (no need to walk the rest) or when `hasNextPage` is false (the thread is genuinely absent — don't fabricate a node id).

2. **Resolve it** with the node id from step 1:

   ```sh
   gh api graphql -f query='mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}' -F threadId=PRRT_xxx
   ```

   The returned `isResolved: true` is your proof it landed. As with every repo-targeting `gh` call, this is a **single bare `gh` invocation** — no pipes, `;`, `&&`, heredocs, or command substitution (the `github-cli-auth` plugin injects the App token into the command's environment; a pipeline would leak it). `-F` passes the id as a typed variable, so there is no shell-metacharacter hazard for the simple id/number values here.

### Self-loop safety — resolving never wakes you

Resolving your own thread is safe from the self-response loop. The `pull_request_review_thread.resolved` webhook that GitHub emits carries **you** as its `sender`, and the inbound classifier maps `pull_request_review_thread` events to their `sender` (not the PR opener) for the self-author drop — so the bot resolving a thread is recognized as self-authored and dropped, exactly like the decoy-reviewer cleanup in the PR review flow. You will not be re-woken by your own resolution. See "Self-loop safety" below.

## Opening new issues and PRs

The `gh` CLI is pre-authenticated via `GH_TOKEN` (injected by the adapter at startup). Use it to open new issues or PRs:

```sh
# Open a new issue
gh issue create --repo owner/repo --title "Bug: ..." --body "..."

# Open a new PR
gh pr create --repo owner/repo --title "Fix: ..." --head my-branch --base main --body "..."
```

For App auth, `GH_TOKEN` is an installation access token that refreshes automatically — it stays current as long as the adapter is running.

## Self-loop safety

The adapter will **not** wake you when you assign yourself as a reviewer (e.g., via `gh pr edit --add-reviewer`). It will only wake you when someone else requests your review.

The same guard covers **removing** a reviewer: when the adapter drops the decoy after your review lands (step 6 of the PR review flow), the `DELETE` is authenticated as the App, so the `review_request_removed` webhook GitHub emits carries your bot actor (`slug[bot]`) as its `sender`, which the classifier drops. So the cleanup never echoes back as a fresh wake. Both directions — add and remove — are matched on `sender.login` (against either the bot actor or its decoy), so any reviewer-list mutation made under your identity stays silent.
