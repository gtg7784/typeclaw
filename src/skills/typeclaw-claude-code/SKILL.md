---
name: typeclaw-claude-code
description: Use this skill whenever you decide to delegate substantial coding or code-analysis work to Claude Code (Anthropic's official coding-agent CLI). Triggers include "use Claude Code", "ask Claude Code", "delegate to claude", "claude cli", "have claude do it", any task where you want a more capable agent than yourself, and any time you're about to run `claude` from a shell. Read it before you spawn the CLI — Claude Code is a TTY-only TUI in interactive mode (you must drive it through tmux, not pipes), it operates inside a dedicated `git worktree` checkout under `/tmp/` so its commits never pollute the agent folder, and you detect "turn done" through a `Stop` hook that writes a sentinel file. Skipping this skill means you'll either fall back to `claude -p` (which strips plan mode and sub-agents), let claude mutate the live agent checkout (which loses you the rollback safety), or try to parse the TUI buffer with capture-pane heuristics (fragile, version-locked).
---

# typeclaw-claude-code

You can delegate work to Claude Code, Anthropic's official coding agent. The agent runs as an interactive TUI: it plans, uses sub-agents, edits files, runs tools — the full loop. You drive it through tmux because your own process has no TTY, you isolate it in a dedicated `git worktree` so its experiments never touch the live agent checkout, and you detect "turn done" through a `Stop` hook that writes a sentinel file (not by parsing the TUI buffer).

This skill is for the case where Claude Code is the right tool: hard architecture work, multi-file refactors, deep code analysis, a second-opinion read on something you wrote. It is **not** for trivial edits — the round-trip cost (worktree setup + process spawn + auth check + TUI init + at least one full Claude turn) is 15–45 seconds and several thousand tokens of someone else's context window. Do trivial edits yourself.

## Run the delegation inside `operator`, not inline

Once you've decided Claude Code is the right tool, spawn the bundled `operator` subagent to do the actual driving — don't run the worktree setup, the tmux session, the polling loop, the multi-turn decision loop, and the cleanup inline in your own context. The whole loop typically takes several minutes and produces large amounts of intermediate output (TUI buffer captures, Stop sentinels per turn, JSONL transcript references); running it inline blocks the user from talking to you and burns through your context window before you ever get to the synthesis step. `operator` is write-capable and runs the same loop, then returns a clean final report (what claude produced, what `git diff main..cc-<id>` shows, what you should review). You ship the worktree, the prompt, and the safety constraints to operator; operator ships you back the diff and the summary.

Exception: a quick sanity ping (`claude --version` to check the binary exists, `env | grep ANTHROPIC` to check auth). Those are single fast bash calls — do them inline. The "spawn through operator" rule applies to anything that runs `claude` itself as an interactive TUI.

## When to delegate to Claude Code

Use Claude Code for:

- **Multi-file refactors** that need a holistic plan before any edit lands.
- **Code analysis** the user wants done thoroughly — "review this module", "find the bug in this 800-line file", "explain why X is slow".
- **Implementations you're unsure about** where a more capable model would catch issues you'd miss.
- **A second pair of eyes** on a design you've already drafted, especially when the user asks for one.

Do **not** use Claude Code for:

- One-line edits, typo fixes, single-function tweaks.
- Anything where the user is watching your tool calls and wants to see each step — Claude's intermediate output is captured but not streamed back to the user.
- Tasks that depend on context you haven't extracted yet. Claude won't have repo-wide context either; you have to brief it explicitly.

## First-time auth (interactive)

If `claude` is installed but no credential is set up, you have to broker the auth flow yourself. The user is talking to you through the TUI (or a channel); you walk them through one of two paths.

**Decision rule, top to bottom:**

1. **Already authenticated?** Run `env | grep -E '^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)='` — if either is present, skip auth entirely.
2. **User has an Anthropic Console workspace** (API billing, no subscription) → API key path.
3. **User has a Claude Pro/Max/Team/Enterprise subscription** → OAuth token path.
4. **User is unsure** → ask which kind of Claude account they have. Both paths are now equally low-friction (one user action each — paste an API key, or run one command on their machine and paste the result), so the old "prefer API key when unsure" bias is gone. Pick by account shape, not by flow complexity.

Both paths converge on the same final steps: read `.env`, merge one new `KEY=value` line, write back with the `nonWorkspaceWrite` guard ack, verify, and prompt the user to restart the container. Only the credential differs.

### API key path

1. Ask the user: "Paste your Anthropic API key (starts with `sk-ant-`) — or say 'cancel' to use OAuth instead."
2. **Validate** the pasted value before writing: `/^sk-ant-[A-Za-z0-9_-]{20,}$/`. If it doesn't match, refuse and ask again — neither the guard nor the restart tool catches a malformed token.
3. **Read** the existing `.env` first (if any). Parse it into a key→value map so you don't clobber unrelated entries.
4. **Reconstruct** the full `.env` content with `ANTHROPIC_API_KEY=<value>` added or replaced.
5. **Write** with `acknowledgeGuards: { nonWorkspaceWrite: true }`. `.env` is in the `nonWorkspaceWrite` guard's deny set; the call fails without the ack flag.
6. **Verify** by re-reading the file.
7. **Ask the user**: "Auth is on disk. The container needs to restart to load it (TUI will briefly disconnect). May I restart now, or do you have other changes to make first?"
8. On yes → call the `restart` tool. On no → tell them to run `typeclaw restart` themselves when ready.

### OAuth path

The OAuth flow runs **on the user's own machine**, not inside the container. The user generates a long-lived `CLAUDE_CODE_OAUTH_TOKEN` with `claude setup-token` on whatever local machine they're already authenticated on, copies the printed token, and pastes it back to you. You write it to `.env` exactly like the API key path.

Why this works: `claude setup-token` is Anthropic's documented path for "CI pipelines, scripts, or other environments where interactive browser login isn't available" ([code.claude.com/docs/en/authentication](https://code.claude.com/docs/en/authentication)). A typeclaw container is exactly that environment. The token is one-year-lived, authenticates against the user's Claude subscription, and is scoped to inference only — it can't establish Remote Control sessions or otherwise act outside of `claude` CLI calls.

Do **not** run `claude setup-token` inside the container. The container has no browser, no display, and (for remote-host typeclaw deployments) is on a different machine from the user's browser anyway. The user's local machine already has `claude` installed for them to be a subscriber in the first place — they're the right place to run the one-off `setup-token` command.

1. Confirm with the user: "Do you have the `claude` CLI installed on your local machine and are you signed in to it with your Claude Pro/Max/Team/Enterprise account? If not, install it from claude.com/code and `claude login` first."
2. Once they confirm, instruct them: "Run `claude setup-token` on your machine. It opens a browser, you authorize, and the terminal prints a long token (looks like `sk-ant-oat01-...` or similar). Copy that token and paste it back to me. The token is long-lived (one year) and authenticates against your Claude subscription — keep it private."
3. When they paste, **validate** before writing: `/^[A-Za-z0-9_-]{30,}$/`. Strip surrounding whitespace first. If it doesn't match (too short, contains slashes, looks like a URL or a sentence), refuse and ask again — the user may have pasted a partial copy or the wrong line.
4. **Read** the existing `.env` first. Parse it into a key→value map.
5. **Reconstruct** the full `.env` content with `CLAUDE_CODE_OAUTH_TOKEN=<value>` added or replaced.
6. **Write** with `acknowledgeGuards: { nonWorkspaceWrite: true }`.
7. **Verify** by re-reading the file.
8. **Ask before restart** (same prompt as the API key path).
9. On yes → call the `restart` tool. On no → `typeclaw restart` themselves when ready.

The full validation rules, the failure modes on the user's side (their `claude` CLI is signed out, their `setup-token` command 401s, their subscription is expired), and the rationale for not doing the OAuth dance in-container are in `references/auth-flow.md`.

### Cost-cap warning

Interactive-mode Claude Code has **no built-in spend cap** — `--max-budget-usd` only works in `-p` mode, which is not what we use here. If the user is on the API-key path, recommend setting a workspace spend limit in the Anthropic Console; that's the only safety net. If they're on OAuth (subscription), usage is bounded by the subscription's monthly Agent SDK credit pool. Tell them once before the first delegation so it's not a surprise.

## Prerequisites

Before you spawn `claude` for any real work:

- **`docker.file.claudeCode: true`** in `typeclaw.json`. Verify with `which claude`; if missing, the toggle isn't on. Tell the user to enable it and `typeclaw start --build`.
- **`docker.file.tmux: true`** (default `true`, but check). Verify with `which tmux`.
- **Auth set up** — see above. Verify with `env | grep -E '^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)='`.
- **Onboarding pre-seeded.** The Dockerfile layer writes `~/.claude.json` with `hasCompletedOnboarding: true` and `theme: "dark"` so the first `claude` invocation skips the TTY-only theme picker / welcome wizard. **This is necessary but not sufficient** — even with the seed, Claude Code can still land on two other pre-prompt modals: the "Detected a custom API key from environment. Do you want to use this API key?" confirmation (when `ANTHROPIC_API_KEY` is set in env — default focus is **No**, so `Down Enter` is needed to accept) and the workspace trust dialog ("Do you trust the files in this folder?", default focus already on **Yes**, so a bare `Enter` accepts). The "Driving the session" section below clears them as a loop. If `~/.claude.json` is empty or missing entirely (custom mount, manual `rm`, a `CLAUDE_CONFIG_DIR` pointing at a fresh directory), the theme picker also reappears. Self-heal: `printf '%s\n' '{"hasCompletedOnboarding":true,"theme":"dark","installMethod":"native","numStartups":1}' > "$HOME/.claude.json"` before spawning, then retry.
- **Agent folder is a git repo.** Verify with `git -C /agent rev-parse --is-inside-work-tree`. The worktree model below requires it. If the user's agent folder somehow isn't a repo (rare — `typeclaw init` scaffolds one), tell them to `git init && git add -A && git commit -m "initial"` first.
- **No uncommitted changes that you care about.** `git -C /agent status --porcelain` should be clean, or you should be willing to set the working tree aside before delegating. The worktree is a separate checkout, so claude can't see your uncommitted changes — meaning claude operates on the last committed state. If the user wants claude to work with in-progress edits, commit them first (even on a WIP branch).

If any prerequisite is missing, stop and surface the gap to the user. Do not try to install `claude` yourself in the running container — the install belongs in the Dockerfile layer, not at runtime.

## Create the worktree

Each delegation runs inside a dedicated `git worktree` checkout under `/tmp/`. This is the load-bearing isolation that makes the rest of the skill safe:

- **Claude can edit, commit, reset, run tests** — none of it touches the agent folder's live working tree or its main branch pointer.
- **You get perfect introspection.** `git diff` between claude's branch and your main checkout shows exactly what claude changed; `git log` shows how it got there.
- **Cleanup is bounded.** When you're done, you remove the worktree and its branch; nothing persists on disk except deliberately cherry-picked commits.
- **The agent folder's `git status` stays clean during delegation** — the user can keep working on their own checkout while claude operates in parallel.

### Setup

Pick a task id (short hex string or `verb-noun` like `refactor-auth`) and create the worktree:

```sh
git -C /agent worktree add -b cc-<task-id> /tmp/cc-<task-id> HEAD
cd /tmp/cc-<task-id>
mkdir -p .claude
```

This creates:

- A new branch `cc-<task-id>` rooted at the agent folder's current `HEAD`.
- A new working tree at `/tmp/cc-<task-id>/` containing every file from that commit.
- An entry in `/agent/.git/worktrees/cc-<task-id>/` that ties the two together.

The worktree shares the agent folder's `.git` directory but has its own `HEAD`, index, and working tree. Branch state lives in `/agent/.git/refs/heads/cc-<task-id>` regardless of where the worktree itself lives on disk.

Inside `/tmp/cc-<task-id>/`, write the per-task hook config (see "The Stop hook" below):

```
/tmp/cc-<task-id>/
├── .claude/
│   └── settings.json        # registers the Stop hook
├── hook-on-stop.sh          # the hook script, chmod +x
├── sentinel.json            # written by the hook (does not exist yet)
└── .done                    # flag file (does not exist yet)
└── ...                      # plus every file from the agent folder's HEAD
```

### Why `/tmp/`, not `workspace/`?

`workspace/` is the agent folder's gitignored scratch zone — fine for one-off scripts. But a `git worktree` is a _checkout_, not scratch: it carries an index, refs in `/agent/.git/worktrees/`, and (briefly) shares working-tree state with the main checkout. Putting it under `workspace/` would mean the agent folder contains a worktree of itself, which works mechanically but is recursive and confusing (nested worktrees? infinite recursion if claude does `git status`?). `/tmp/cc-<id>/` keeps the worktree clearly outside the agent folder. It's also genuinely ephemeral — `/tmp/` is tmpfs-ish, survives container life but never enters git history or backups.

## The Stop hook

Claude Code fires a `Stop` hook every time it finishes responding — turn-end, not session-end. The hook runs an arbitrary shell command with the lifecycle event payload (JSON) on stdin. We use this as the done-signal: the hook writes the payload to `sentinel.json` and `touch`es `.done`, and your polling loop watches for `.done`.

Minimum `/tmp/cc-<id>/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "./hook-on-stop.sh" }]
      }
    ]
  }
}
```

Minimum `/tmp/cc-<id>/hook-on-stop.sh` (chmod +x):

```sh
#!/bin/sh
# stdin carries the Stop event JSON; transcript_path points at the JSONL.
cat > sentinel.json.tmp
mv sentinel.json.tmp sentinel.json
touch .done
```

The temp-file-then-rename keeps the read side from ever seeing a partial sentinel. The full schema of the Stop event (every field Claude Code populates, including `last_assistant_message` and `transcript_path`) is in `references/stop-hook.md`.

## Driving the session

The minimum protocol — translate to your actual tool calls:

1. Create the worktree, write the hook config (above).
2. `tmux new-session -d -s cc-<id> -c /tmp/cc-<id> claude`.
3. Wait ~3 seconds for the TUI to initialize.
4. **Clear startup dialogs (BEFORE sending the task prompt).** Even with `~/.claude.json` pre-seeded, claude can land on one or both pre-prompt modals. Run this as a **loop**, not a one-shot: clearing one dialog can immediately reveal the next, and you must keep polling until claude's actual input prompt is visible (it renders a bottom-of-pane input box with a `╭` / `╰` border).

   The two known modals, with the exact keystrokes for each (Claude Code's select widget does NOT wrap — pressing `Up` from the first option is a no-op, so the direction must match the dialog's option order):
   - **Custom API key confirmation** — "Detected a custom API key from environment. Do you want to use this API key?" Fires when `ANTHROPIC_API_KEY` is set (exactly typeclaw's auth path). Options are `[No (recommended), Yes]` with focus initialized on **No**. Resolution: `tmux send-keys -t cc-<id> Down Enter` to advance to **Yes** and submit. Sending `Up Enter` would submit the **No** answer, which can persist as a rejection in `customApiKeyResponses.rejected` and break subsequent launches — never do that here.

   - **Workspace trust** — "Do you trust the files in this folder?" Fires on first launch in any new cwd, so every fresh `/tmp/cc-<id>/` worktree triggers it. Options are `[Yes, proceed, No, exit]` with focus on the first option (**Yes**) by default. Resolution: bare `tmux send-keys -t cc-<id> Enter` — no arrow key needed. Always verify the pane text matches the trust dialog before pressing Enter; a misidentified modal would submit a different default.

   Loop shape (translate to your tool calls):
   1. Capture the last ~15 lines: `tmux capture-pane -t cc-<id> -p -S -15`.
   2. If the capture contains the API key dialog text → `send-keys Down Enter`, sleep 500ms, goto 1.
   3. If the capture contains the trust dialog text → `send-keys Enter`, sleep 500ms, goto 1.
   4. If the capture shows the input box (`╭` border on a bottom line, no dialog text above it) → ready; exit the loop.
   5. Otherwise sleep 500ms, goto 1. Apply a wall-clock budget of ~10 seconds; if the loop hasn't reached step 4 by then, abort with `/exit` and surface to the user — claude is in a state this skill doesn't model.

   Do not use a fixed 2-second wait then send the prompt — cold-start and slow-disk cases can deliver a dialog at 2.5s+, and sending the task prompt into a modal corrupts the session.

   **Safety note**: accepting workspace trust on a fresh `/tmp/cc-<id>/` worktree is the right call **only when its `HEAD` is the intended clean state** — typically the agent folder's last good commit on a branch the user controls. If the user just merged a third-party PR, pulled a remote branch, or checked out an untrusted ref, the worktree carries that content too and "trusting" it gives claude tool access on potentially hostile code. Before auto-accepting trust, sanity-check: if the user hasn't said something equivalent to "delegate this to Claude Code", or if you're not confident the current `HEAD` is one the user authored or reviewed, surface the trust dialog to them instead. Do NOT extend even a legitimate trust acceptance to in-session permission prompts (Bash, Edit, etc.) — those still need per-turn judgment per the multi-turn decision loop below.

5. `tmux send-keys -t cc-<id> "<your prompt>" Enter`.
6. **Poll** for `/tmp/cc-<id>/.done` in a 500ms-cadence loop with a wall-clock budget (default 10 minutes). On every iteration, also check `tmux has-session -t cc-<id>` — if the session died, claude crashed or auth failed.
7. When `.done` exists: `rm .done`, read `sentinel.json`, examine `last_assistant_message`.
8. Decide using the multi-turn loop below.
9. When done: `tmux send-keys -t cc-<id> "/exit" Enter && sleep 1 && tmux kill-session -t cc-<id>`.

The full polling implementation, the ANSI-handling rules for `capture-pane` fallbacks, and the "tmux session died unexpectedly" recovery path are in `references/tmux-driving.md`.

## The multi-turn decision loop

`Stop` fires every turn — including turns where claude paused to ask you a question, not just turns where claude finished the task. After every Stop sentinel, read `last_assistant_message` and decide:

- **Ends with a question mark, or contains "Do you want me to", "Should I", "Could you clarify"** → claude is asking a clarifying question. Compose an answer from the original task brief and `send-keys` it back. Reset the loop: `rm .done`, poll again.
- **Mentions a permission-style ask** ("May I run `<command>`?", "Allow me to edit `<file>`?") → answer per the task's safety constraints. If the constraint is unclear, abort with `/exit` and surface to the user — never invent a yes/no on the user's behalf for an unbounded operation.
- **Looks like a final result** (code block + summary, or "Done.", "Here's the result.", "I've finished") → capture and `/exit`.
- **Looks like a status update mid-tool-use** ("Let me check…", "Reading the file now…") → this is a spurious Stop (a Claude turn-boundary that isn't real task progress). Just `rm .done` and keep polling.

**Hard turn cap: 8 turns per delegation.** Beyond that, either the task is too complex to delegate cleanly or claude is stuck in a loop. Abort with `/exit`, capture what you have, surface to the user with: "Claude took 8 turns without finishing — here's what it produced, what do you want to do?"

This loop is the most failure-prone part of the skill. If you find yourself uncertain whether a message is a question or a result, **default to surfacing to the user**, not to guessing. Wrong answers compound across turns.

## Capturing the output

Four sources, in order of preference:

1. **`git diff /agent main..cc-<id>`** (run from `/agent`, or use the explicit worktree path). This is the killer feature of the worktree model — the exact set of changes claude made, branch-vs-branch. Use this for code-change tasks.
2. **`git log cc-<id> --oneline main..cc-<id>`** for how claude got there (the sequence of commits). Useful when claude broke a refactor into steps you want to attribute or cherry-pick.
3. **`sentinel.json` from the final turn** (`last_assistant_message`). The narrative summary claude gave you. Use this for analysis tasks where the answer is prose, not code.
4. **The JSONL transcript** at `transcript_path` in the sentinel. The complete conversation including intermediate tool calls. Use when the diff/log aren't enough and you need to see how claude reasoned. Schema in `references/stop-hook.md`.

For code-change tasks, the canonical pattern is:

1. Read `last_assistant_message` for the summary.
2. Run `git diff main..cc-<id> -- <files>` to see the actual changes.
3. Decide: are these changes good? If yes, either `git cherry-pick <commits>` onto the agent folder's branch OR copy the changes manually into the main checkout and commit there with proper attribution (per `typeclaw-git`).
4. Throw away the `cc-<id>` branch.

Never paste Claude's output verbatim into your reply or a commit message. Summarize, attribute ("Claude Code's analysis: ..."), and stay accountable for the work. You delegated up; you didn't outsource ownership.

## Cleanup discipline

Cleanup is git-aware: a worktree isn't just a directory. Three steps, in order:

```sh
tmux kill-session -t cc-<id> 2>/dev/null || true
git -C /agent worktree remove --force /tmp/cc-<id>
git -C /agent branch -D cc-<id>
```

- **`tmux kill-session`** first because claude might still be holding files open. `|| true` because a clean `/exit` already killed the session.
- **`git worktree remove --force`** because the working tree may have dirty files (the sentinel, the hook script, claude's in-progress edits). `--force` skips the "uncommitted changes" check; this is correct here because we're explicitly discarding the worktree.
- **`git branch -D cc-<id>`** to delete the branch ref. Without this, `cc-<id>` lingers in `git branch -a` indefinitely. `-D` (capital) because `cc-<id>` is unmerged into anything you care about.

Always do all three, including on failure paths. Orphan worktrees:

- Show up in `git worktree list` forever.
- Cause `git status` in the agent folder to mention "another worktree exists at /tmp/cc-<id>" if you `cd` somewhere related.
- Make the next delegation with the same task-id fail with "branch already exists".

Before starting a new delegation, check for orphans:

```sh
git -C /agent worktree list | grep cc-
tmux ls 2>/dev/null | grep '^cc-'
```

Kill anything you find first.

## When not to delegate

A re-statement, because this is where the skill is most often misused:

- **Trivial edits**: the round-trip cost dominates. Do it yourself.
- **Tasks needing live user visibility**: claude's tool calls don't stream back through TypeClaw. The user sees a long pause, not progress. Use your own tools.
- **Tasks where you don't have the context to brief claude**: spend tokens narrowing the problem first. A vague delegation produces a vague result.
- **Anything secret beyond `ANTHROPIC_API_KEY`**: claude only sees the prompt you send it and the files in its worktree (which is everything at `HEAD`). Don't try to pass secrets through the prompt — they'll land in claude's transcript and in your sentinel.

## Things you must not do

- **Do not use `claude -p` for delegation work.** The headless print mode strips plan mode, sub-agents, and the agent loop. The whole reason to delegate up is the loop. If you find yourself reaching for `-p`, the right answer is probably "do it yourself".
- **Do not run `claude` directly inside `/agent`.** Always inside `/tmp/cc-<id>/`. Running claude in the agent folder lets it mutate the live working tree and break the user's session in flight.
- **Do not skip the worktree.** Even for short delegations, the worktree is what gives you the `git diff` introspection and the rollback safety. Skipping it because "this one's small" is the path to claude accidentally committing on the wrong branch.
- **Do not share a tmux session across two delegated tasks.** Each task needs its own worktree, its own session, and its own `.claude/settings.json`. Sharing corrupts the sentinel state and crosses transcripts.
- **Do not leave a tmux session, worktree, or branch alive after capturing the result.** All three need explicit teardown. Reusing them defeats the per-task isolation that makes the Stop hook reliable.
- **Do not push claude's branch to a remote.** `cc-<id>` is throwaway. If something useful happened, cherry-pick onto a real branch first; don't push the experimental branch directly.
- **Do not merge claude's branch into main without reviewing the diff.** The `git diff main..cc-<id>` is your review surface. Skipping the diff and merging blindly means you don't actually know what shipped.
- **Do not commit `/tmp/cc-<id>/` artifacts back to the agent folder.** The sentinel, the hook script, the captured pane content are scratch — they live in `/tmp/`, they die with `worktree remove`.
- **Do not paste Claude's output verbatim into a commit message or a user reply.** Summarize and attribute. You're accountable for the work you ship.
- **Do not put `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` in `typeclaw.json`, in a prompt, or in any committed file.** They live in `.env`, which is gitignored. Period.
- **Do not poll the JSONL transcript directly as the done-signal.** The JSONL has documented race conditions (the file can be stale when `Stop` fires, or occasionally missing entirely). The sentinel is the reliable signal; the JSONL is for content, not lifecycle.
- **Do not write to `.env` without `acknowledgeGuards: { nonWorkspaceWrite: true }`.** The guard will refuse, the agent loop will retry the same broken write, and you'll waste tokens fighting the guard. The ack is required every write, not just the first one.
- **Do not edit `.env` with the `edit` tool's patch semantics.** Use read-modify-write: read the whole file, reconstruct the new content, write the whole file. `.env` is a flat KV store; a fragile `oldText` match could corrupt unrelated lines.
- **Do not run `claude setup-token` inside the container.** It's a TUI OAuth flow that wants a browser. The container has no display, no browser, and is often on a different machine from the user anyway. Always have the user run `setup-token` on their own machine and paste the resulting token back; never spawn it in tmux on this side.
- **Do not echo, log, or transcribe the pasted `CLAUDE_CODE_OAUTH_TOKEN` value back to the user, into a sentinel, into a commit message, or into any message you send.** It's a one-year credential. Confirm receipt with "got it, validating" — never with the token itself.
- **Do not invent answers to Claude's clarifying questions.** If you can't derive the answer from the original task brief, surface the question to the user. Wrong answers compound across multi-turn delegations.
- **Do not exceed 8 turns per delegation.** Abort, capture what you have, surface. Long delegations almost always mean the task wasn't shaped right.
- **Do not assume `claude` exists.** If `which claude` returns empty, the `docker.file.claudeCode` toggle isn't on. Tell the user, don't try to install it yourself.

## Cross-references

- **`references/auth-flow.md`** — both auth paths in detail: the API-key recap, the OAuth user-machine flow (what to tell the user, what their `claude setup-token` output looks like, validation rules), and the failure-mode catalogue (expired subscription, wrong account, malformed paste).
- **`references/tmux-driving.md`** — full polling implementation, ANSI handling, session-died recovery, the `capture-pane` fallback details, the worktree-is-not-scratch distinction.
- **`references/stop-hook.md`** — complete `Stop` event JSON schema, `SubagentStop` differences, transcript JSONL schema (unofficial but reverse-engineered), documented race conditions to handle.
- **`typeclaw-config`** — the `docker.file.claudeCode` toggle that gates the install.
- **`typeclaw-git`** — commit discipline for any cherry-picks or hand-copies from claude's worktree back into the agent folder.
- **`typeclaw-monorepo`** — the `workspace/` vs `packages/` distinction (this skill uses `/tmp/`, not `workspace/`, for reasons explained above).
