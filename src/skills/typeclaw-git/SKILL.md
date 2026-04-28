---
name: typeclaw-git
description: Use this skill whenever you edit any file in the agent folder — config, cron, memory, identity, scaffolded markdown, scripts, anything tracked by git. Triggers include any `write`/`edit` tool call against a non-gitignored file, any time you finish a logical change, or any mention of "commit", "git", "version control", "history", or "what did I change". Read it before you edit, not after — the rule is *commit immediately after every edit, with decision context in the message*. Skipping the commit pollutes the next one; skipping the decision context makes the history useless to future-you.
---

# typeclaw-git

Your agent folder is a git repo. Almost every file in it (`typeclaw.json`, `cron.json`, `MEMORY.md`, `IDENTITY.md`, `SOUL.md`, `USER.md`, `AGENTS.md`, scaffolded markdown, scripts you write, etc.) is tracked.

The contents of `.gitignore` split into two distinct categories — the distinction matters for this skill:

- **Truly ignored** (`.env`, `node_modules/`, `workspace/`, `mounts/`, `.DS_Store`) — never in history, ever. Secrets, runtime junk, and your free-write zone.
- **System-managed** (`sessions/`, `memory/`) — gitignored so _you_ don't stage them, but TypeClaw force-commits them on its own schedule. `sessions/` is auto-backed up by the runtime; `memory/` is committed by the dreaming subagent. Treat them as runtime-owned: do not `git add` them, do not write commit messages about them, and do not be alarmed when they appear in `git log`.

Everything not in either bucket is yours to commit.

This skill exists so the history of your agent folder stays a useful record of _why things changed_, not just a pile of "update X" commits.

## The rule

**Every time you edit a tracked file, commit it before you move on. Every commit message records why the change was made, not just what changed.**

Two halves, both mandatory:

1. **Commit immediately after the edit.** Don't batch unrelated changes. Don't leave dirty files lying around for the next turn to sweep up. The diff already shows what — the commit pins it to a moment with a reason.
2. **Decision context in the message.** The diff answers _what_. The message must answer _why_. If commenting out the message body wouldn't change how a reader understands the commit, the message is failing its job.

This applies to every tracked file, not just `typeclaw.json` and `cron.json`. New file types we introduce later (memory snapshots, scaffolded skills, scripts) inherit the same rule by default.

## What "decision context" means

A commit message body must answer at least:

- **Trigger** — what request, observation, or failure prompted this edit. Quote the user verbatim if they asked for it. Reference the prior state if you reacted to a problem.
- **Choice** — why this specific value/approach, especially when alternatives existed. Skip only when the choice is mechanical and obvious from the diff.
- **Constraints honored** — any skill rule, schema limit, or runtime semantic that shaped the edit, when it's relevant to understanding the choice.

A one-line subject is fine when the choice is mechanical (typo fix, formatting). The body is required whenever there was a real decision.

### Good

```
Add daily-summary cron at 23:30 KST

User asked for an end-of-day session recap. Picked `prompt` over
`exec` because summarization needs LLM judgement. Set
`timezone: Asia/Seoul` so the day boundary matches the user's
local clock, not UTC.
```

### Bad

```
update cron
```

```
Add job
```

```
Change port to 8974
```

(All three: no trigger, no choice, no constraints. Comment them out and nothing is lost.)

## Workflow

1. Edit the file with `write`/`edit`.
2. Run any post-edit validation the file's domain requires (e.g. `reload` for `cron.json`, `jq .` sanity check for `typeclaw.json`). Don't commit broken files.
3. `git add <file> && git commit -m "<subject>" -m "<body>"`. Imperative subject, body explains why.
4. Move on.

If a single logical change touches multiple files (e.g. updating `typeclaw.json` _and_ a related script), commit them together — one commit, one decision. Don't split a single decision across commits.

If you discover an unrelated dirty file from a previous turn, commit it separately first with its own decision context (reconstruct from the diff and prior session if needed) before starting your current edit. Never let an unrelated change ride along.

## Things you must not do

- **Do not skip the commit** "because the change is small." Small changes are exactly the ones that get lost. Toggling `enabled: false` on a cron job is a decision; commit it.
- **Do not write empty or generic messages** ("update", "fix", "change config"). The history exists to be read.
- **Do not amend or force-push** to clean up later. Sloppy history with real commits beats clean history that lies about when decisions happened.
- **Do not commit `.env` or anything truly-ignored.** If `git status` shows a truly-ignored file as staged, something is wrong with `.gitignore` — fix that first, don't commit the secret.
- **Do not commit `sessions/` or `memory/` either, even though `git log` shows them.** They're system-managed: TypeClaw's auto-backup and dreaming subagent own those commits. If you find one of them staged in your working tree, unstage it (`git restore --staged sessions/ memory/`) — your edit got mixed up with the runtime's domain.
- **Do not bundle unrelated changes.** One commit, one decision.

## When you are unsure

If you can't articulate _why_ you're making a change in one sentence, you don't understand the change well enough to make it. Stop, re-read the request, and either ask the user or work it out before editing. Editing first and inventing a reason for the commit message later is the failure mode this skill exists to prevent.
