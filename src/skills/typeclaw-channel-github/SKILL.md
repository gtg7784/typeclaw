---
name: typeclaw-channel-github
description: Use this skill BEFORE every `channel_reply` or `channel_send` call whose adapter is `github`, AND before composing replies to GitHub-originated inbounds, AND before opening new issues or PRs with `gh`. GitHub renders **real markdown** — `**bold**`, `## headings`, `| tables |`, fenced code blocks, and `inline code` all render natively. Use rich markdown freely. GitHub cannot send file attachments via API — do not call `channel_send` with attachments on github chats. GitHub has no typing indicator. PR review threads use `thread` keyed on the root comment id; reply to a thread to stay in it, or omit `thread` to post a top-level issue/PR comment. To open new issues or PRs use the `gh` CLI — `GH_TOKEN` is pre-set by the adapter. Read this skill before composing anything on GitHub.
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
