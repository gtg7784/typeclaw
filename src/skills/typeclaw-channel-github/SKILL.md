---
name: typeclaw-channel-github
description: Use this skill BEFORE every `channel_reply` or `channel_send` call whose adapter is `github`, AND before composing replies to GitHub-originated inbounds, AND before opening new issues or PRs with `gh`, AND ALWAYS when an inbound says "requested your review on PR #N" or "requested a review from team @… on PR #N" (the agent has been assigned as a reviewer and must do a real code review with line-by-line comments via `gh api`). GitHub renders **real markdown** — `**bold**`, `## headings`, `| tables |`, fenced code blocks, and `inline code` all render natively. Use rich markdown freely. GitHub cannot send file attachments via API — do not call `channel_send` with attachments on github chats. GitHub has no typing indicator. PR review threads use `thread` keyed on the root comment id; reply to a thread to stay in it, or omit `thread` to post a top-level issue/PR comment. To open new issues or PRs use the `gh` CLI — `GH_TOKEN` is pre-set by the adapter. Read this skill before composing anything on GitHub.
---

GitHub renders normal Markdown in issues, PRs, discussions, and review comments. Use headings, lists, tables, fenced code blocks, links, and inline code when they improve clarity.

- Do not send attachments on GitHub chats; the adapter rejects them.
- There is no typing indicator.
- For PR review threads, keep `thread` set to reply in-place. Omit `thread` for a top-level PR/issue comment.

## Opening new issues and PRs

The `gh` CLI is pre-authenticated via `GH_TOKEN` (injected by the adapter at startup). Use it to open new issues or PRs:

```sh
# Open a new issue
gh issue create --repo owner/repo --title "Bug: ..." --body "..."

# Open a new PR
gh pr create --repo owner/repo --title "Fix: ..." --head my-branch --base main --body "..."
```

For App auth, `GH_TOKEN` is an installation access token that refreshes automatically — it stays current as long as the adapter is running.

## Reviewing pull requests

When an incoming message says **"requested your review on PR #N"** (or "requested a review from team @… on PR #N"), you have been assigned as a reviewer. Do a real code review and post line-by-line comments via `gh api`. Do **not** just reply in the channel — the user wants feedback on the diff.

### Workflow

1. **Read the diff and context**:

   ```sh
   gh pr diff <N> --repo owner/repo
   gh pr view <N> --repo owner/repo --json title,body,baseRefName,headRefOid,files
   ```

2. **Submit a multi-comment review** in one API call. `comments[]` accepts line-level entries; each one lands on the diff exactly like a human reviewer's inline comment:

   ```sh
   gh api -X POST /repos/owner/repo/pulls/<N>/reviews \
     -F event=COMMENT \
     -f body="Overall: looks good with a few nits." \
     -F 'comments[][path]=src/foo.ts' \
     -F 'comments[][line]=42' \
     -F 'comments[][side]=RIGHT' \
     -F 'comments[][body]=nit: prefer `const` here.' \
     -F 'comments[][path]=src/bar.ts' \
     -F 'comments[][line]=10' \
     -F 'comments[][side]=RIGHT' \
     -F 'comments[][body]=Consider extracting this branch into a helper.'
   ```

3. **Then** post a one-line summary with `channel_reply` so the conversation has a human-readable trace pointing at the review.

### Rules

- Use `event=COMMENT` by default. Use `APPROVE` only when you have high confidence the PR is ready to merge. Use `REQUEST_CHANGES` only when the PR has clear blockers — not for nits.
- `line` is a line number **in the file**, not a position in the diff. `side: RIGHT` is the new revision (default for additions); `side: LEFT` is the old revision (use for comments on removed lines).
- For multi-line comments, also set `start_line` and `start_side` (same semantics).
- If you need to read whole files at the PR's head SHA, use `gh api /repos/owner/repo/contents/<path>?ref=<headRefOid>`.
- The bundled `agent-browser` is **not** for PR reviews — `gh api` is faster and more reliable. Only use the browser when the API genuinely can't reach what you need.
- A `review_request_removed` event means the requester un-assigned you. Stop any in-progress review work; do not post a partial review.

### Self-loop safety

The adapter will **not** wake you when you assign yourself as a reviewer (e.g., via `gh pr edit --add-reviewer`). It will only wake you when someone else requests your review.
