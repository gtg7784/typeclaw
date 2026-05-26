---
name: typeclaw-codex-cli
description: Use this skill whenever you decide to delegate substantial coding or code-analysis work to Codex CLI (OpenAI's official coding-agent CLI, `@openai/codex`). Triggers include "use Codex", "ask Codex", "delegate to codex", "codex cli", "have codex do it", "openai codex", any task where you want a second-opinion agent on top of (or instead of) Claude Code, and any time you're about to run `codex` from a shell. Read it before you spawn the CLI — Codex is a TTY-only TUI in interactive mode (you must drive it through tmux, not pipes), it operates inside a dedicated `git worktree` checkout under `/tmp/` so its commits never pollute the agent folder, and you detect "turn done" through a `Stop` hook that writes a sentinel file. Skipping this skill means you'll either fall back to `codex exec` (which is single-shot and strips multi-turn agency), let codex mutate the live agent checkout (which loses you the rollback safety), or try to parse the TUI buffer with capture-pane heuristics (fragile, version-locked).
---

# typeclaw-codex-cli

You can delegate work to Codex CLI, OpenAI's official coding agent. The agent runs as an interactive TUI: it plans, edits files, runs tools, asks for approval — the full loop. You drive it through tmux because your own process has no TTY, you isolate it in a dedicated `git worktree` so its experiments never touch the live agent checkout, and you detect "turn done" through a `Stop` hook that writes a sentinel file (not by parsing the TUI buffer).

This skill is for the case where Codex CLI is the right tool: hard architecture work, multi-file refactors, deep code analysis, a second-opinion read on something you wrote (especially when you already used Claude Code and want OpenAI's view, or vice versa). It is **not** for trivial edits — the round-trip cost (worktree setup + process spawn + auth check + TUI init + at least one full Codex turn) is 15–45 seconds and several thousand tokens of someone else's context window. Do trivial edits yourself.

The shape of this skill is intentionally a mirror of `typeclaw-claude-code`: the worktree model, the tmux driving, the `.session-id` discovery, the multi-turn loop, the cleanup discipline are all byte-for-byte equivalent because Codex CLI's hook system ships the same event names (`SessionStart`, `Stop`), the same JSON payload shape (`session_id`, `transcript_path`, `cwd`, `hook_event_name` on stdin), and the same per-session filenames work. What differs is the install path (`@openai/codex` npm package, not curl-bash), the config file location (`~/.codex/hooks.json`, not `~/.claude/settings.json`), the onboarding dialog set (Auth + TrustDirectory, no theme picker), the auth mechanism (`OPENAI_API_KEY` or `codex login`, not Anthropic-specific OAuth), and the project-instruction file (`AGENTS.md`, not `CLAUDE.md`). The runbook is the same; the credentials and the pre-prompt modals differ.

## Run the delegation inside `operator`, not inline

Once you've decided Codex CLI is the right tool, spawn the bundled `operator` subagent to do the actual driving — don't run the worktree setup, the tmux session, the polling loop, the multi-turn decision loop, and the cleanup inline in your own context. The whole loop typically takes several minutes and produces large amounts of intermediate output (TUI buffer captures, Stop sentinels per turn, JSONL transcript references); running it inline blocks the user from talking to you and burns through your context window before you ever get to the synthesis step. `operator` is write-capable and runs the same loop, then returns a clean final report (what codex produced, what `git diff main..cx-<id>` shows, what you should review). You ship the worktree, the prompt, and the safety constraints to operator; operator ships you back the diff and the summary.

Exception: a quick sanity ping (`codex --version` to check the binary exists, `env | grep OPENAI` to check auth). Those are single fast bash calls — do them inline. The "spawn through operator" rule applies to anything that runs `codex` itself as an interactive TUI.

## When to delegate to Codex CLI

Use Codex CLI for:

- **Multi-file refactors** that need a holistic plan before any edit lands.
- **Code analysis** the user wants done thoroughly — "review this module", "find the bug in this 800-line file", "explain why X is slow".
- **Implementations you're unsure about** where a more capable model would catch issues you'd miss.
- **A second pair of eyes** on a design you've already drafted, especially when the user explicitly wants the OpenAI agent's view (the canonical "use Codex for an OpenAI-side second opinion on something Claude already weighed in on" pattern).

Do **not** use Codex CLI for:

- One-line edits, typo fixes, single-function tweaks.
- Anything where the user is watching your tool calls and wants to see each step — Codex's intermediate output is captured but not streamed back to the user.
- Tasks that depend on context you haven't extracted yet. Codex won't have repo-wide context either; you have to brief it explicitly (it will read `AGENTS.md` from the worktree root, but anything outside that file you must put in the prompt).

## First-time auth (interactive)

If `codex` is installed but no credential is set up, you have to broker the auth flow yourself. The user is talking to you through the TUI (or a channel); you walk them through one of two paths.

**Decision rule, top to bottom:**

1. **Already authenticated?** Check both env (`env | grep -E '^(OPENAI_API_KEY|CODEX_API_KEY)='`) and on-disk (`test -f ~/.codex/auth.json`). If either resolves, skip auth entirely.
2. **User has an OpenAI API account** (api.openai.com billing, no ChatGPT Plus/Pro subscription) → API key path.
3. **User has a ChatGPT Plus / Pro / Team / Enterprise subscription and wants to use their subscription credits** → OAuth path via `codex login`.
4. **User is unsure** → ask which kind of OpenAI account they have. Both paths are equally low-friction. Pick by account shape, not by flow complexity.

Both paths converge on the same final steps: read `.env`, merge one new `KEY=value` line or a copied `~/.codex/auth.json`, write back with the `nonWorkspaceWrite` guard ack, verify, and prompt the user to restart the container. Only the credential medium differs.

### API key path

1. Ask the user: "Paste your OpenAI API key (starts with `sk-`) — or say 'cancel' to use the OAuth flow instead."
2. **Validate** the pasted value before writing: `/^sk-[A-Za-z0-9_-]{20,}$/`. If it doesn't match, refuse and ask again — neither the guard nor the restart tool catches a malformed token.
3. **Read** the existing `.env` first (if any). Parse it into a key→value map so you don't clobber unrelated entries.
4. **Reconstruct** the full `.env` content with `OPENAI_API_KEY=<value>` added or replaced. (Codex also honors `CODEX_API_KEY` but that variant only takes effect for `codex exec`, not the interactive TUI we drive here — use `OPENAI_API_KEY`.)
5. **Write** with `acknowledgeGuards: { nonWorkspaceWrite: true }`. `.env` is in the `nonWorkspaceWrite` guard's deny set; the call fails without the ack flag.
6. **Verify** by re-reading the file.
7. **Ask the user**: "Auth is on disk. The container needs to restart to load it (TUI will briefly disconnect). May I restart now, or do you have other changes to make first?"
8. On yes → call the `restart` tool. On no → tell them to run `typeclaw restart` themselves when ready.

### OAuth path

Unlike Claude Code's `claude setup-token` flow, Codex CLI's OAuth (via `codex login`) writes a credential **file** (`~/.codex/auth.json`) on the user's machine rather than printing a long-lived token to stdout. The user logs in locally, copies that file, and you place it into the container's `~/.codex/auth.json` via a write call.

Why this works: `~/.codex/auth.json` is the canonical credential location for the Codex CLI. From the official auth docs: "Credentials are persisted to `~/.codex/auth.json` by default." A typeclaw container, like any CI/headless environment, can simply receive that file from the user's already-authenticated machine. The container has no browser and cannot complete the `localhost:1455` OAuth callback on its own.

1. Confirm with the user: "Do you have the `codex` CLI installed on your local machine and are you signed in to it with your ChatGPT subscription? If not, install with `npm install -g @openai/codex`, then `codex login` and complete the browser authorization."
2. Once they confirm, instruct them: "On your machine, the file at `~/.codex/auth.json` now contains your credential. Paste its contents back to me — it's a small JSON object with an `OPENAI_API_KEY` field, OR a `tokens` object with `access_token` / `refresh_token` / `id_token`. Either shape is valid. Treat it like a password (the `access_token` if present is short-lived but the `refresh_token` is long-lived)."
3. When they paste, **validate** before writing: it must `JSON.parse` cleanly into an object with at least one of `{ OPENAI_API_KEY, tokens }`. If neither field is present, refuse and ask again — the user may have pasted only a fragment.
4. **Write to `~/.codex/auth.json` inside the container**, not `.env`. Create `~/.codex/` first if missing. Use `acknowledgeGuards: { nonWorkspaceWrite: true }` (the `~/.codex/` dir is outside `workspace/`). `~/.codex/auth.json` is symlinked by typeclaw's entrypoint shim to a host-side persistent path, so this write survives container restarts and codex's in-place token refreshes "just work" — see `references/auth-flow.md` "Persistence across container restarts" for the full mechanism.
5. **Verify** by re-reading the file and re-parsing.
6. **Ask before restart** (same prompt as the API key path).
7. On yes → call the `restart` tool. On no → `typeclaw restart` themselves when ready.

The full validation rules, the failure modes on the user's side (their `codex` CLI is signed out, their subscription is expired, their `auth.json` is missing or malformed), and the rationale for not doing the OAuth dance in-container are in `references/auth-flow.md`.

### Cost-cap warning

Interactive-mode Codex CLI has **no built-in spend cap**. If the user is on the API-key path, recommend setting a workspace spend limit at `platform.openai.com/settings/organization/limits`; that's the only safety net. If they're on OAuth (ChatGPT subscription), usage is bounded by the subscription's monthly Codex credit pool — but heavy delegations can still exhaust that pool faster than expected. Tell them once before the first delegation so it's not a surprise.

## Prerequisites

Before you spawn `codex` for any real work:

- **`docker.file.codexCli: true`** in `typeclaw.json`. Verify with `which codex`; if missing, the toggle isn't on. Tell the user to enable it and `typeclaw start --build`.
- **`docker.file.tmux: true`** (default `true`, but check). Verify with `which tmux`.
- **Auth set up** — see above. Verify with `env | grep -E '^(OPENAI_API_KEY|CODEX_API_KEY)='` OR `test -f ~/.codex/auth.json`.
- **No onboarding seed needed.** Unlike Claude Code's `~/.claude.json` + `hasCompletedOnboarding: true` shim, Codex CLI has NO theme picker, NO telemetry consent dialog, NO terms-of-service prompt — verified directly against the upstream `codex-rs/tui/src/onboarding/onboarding_screen.rs` state machine. Codex's onboarding has exactly two interactive steps after the brief Welcome animation: an **Auth picker** (skipped automatically when `OPENAI_API_KEY` is in env or `~/.codex/auth.json` exists) and a **TrustDirectory** prompt (fires once per new cwd). The "Driving the session" section below clears both as a loop. If neither auth medium is present, the Auth picker fires and the delegation cannot proceed without runtime intervention — bail to the user.
- **Agent folder is a git repo.** Verify with `git -C /agent rev-parse --is-inside-work-tree`. The worktree model below requires it. Codex CLI **additionally** requires a git repo by default (use `--skip-git-repo-check` to override, but we don't — the worktree is a git checkout by construction).
- **No uncommitted changes that you care about.** `git -C /agent status --porcelain` should be clean, or you should be willing to set the working tree aside before delegating. The worktree is a separate checkout, so codex can't see your uncommitted changes — meaning codex operates on the last committed state. If the user wants codex to work with in-progress edits, commit them first (even on a WIP branch).

If any prerequisite is missing, stop and surface the gap to the user. Do not try to install `codex` yourself in the running container — the install belongs in the Dockerfile layer, not at runtime.

## Create the worktree

Each delegation runs inside a dedicated `git worktree` checkout under `/tmp/`. This is the load-bearing isolation that makes the rest of the skill safe:

- **Codex can edit, commit, reset, run tests** — none of it touches the agent folder's live working tree or its main branch pointer.
- **You get perfect introspection.** `git diff` between codex's branch and your main checkout shows exactly what codex changed; `git log` shows how it got there.
- **Cleanup is bounded.** When you're done, you remove the worktree and its branch; nothing persists on disk except deliberately cherry-picked commits.
- **The agent folder's `git status` stays clean during delegation** — the user can keep working on their own checkout while codex operates in parallel.

### Setup

Pick a task id (short hex string or `verb-noun` like `refactor-auth`) and create the worktree. Use the `cx-` prefix (not `cc-`) so a parallel Codex + Claude delegation in the same agent folder can't collide on branch names:

```sh
git -C /agent worktree add -b cx-<task-id> /tmp/cx-<task-id> HEAD
cd /tmp/cx-<task-id>
```

This creates:

- A new branch `cx-<task-id>` rooted at the agent folder's current `HEAD`.
- A new working tree at `/tmp/cx-<task-id>/` containing every file from that commit.
- An entry in `/agent/.git/worktrees/cx-<task-id>/` that ties the two together.

The worktree shares the agent folder's `.git` directory but has its own `HEAD`, index, and working tree. Branch state lives in `/agent/.git/refs/heads/cx-<task-id>` regardless of where the worktree itself lives on disk.

No per-task hook config is needed — the Stop and SessionStart hooks are wired globally at Dockerfile-build time (see "The Stop hook" below). Your worktree just becomes the cwd when you spawn `codex`; the global hooks write per-session files into `$PWD` (which `tmux new-session -c /tmp/cx-<id>` sets to the worktree).

```
/tmp/cx-<task-id>/
├── .session-id                  # written by SessionStart hook (fast path)
├── sentinel-<uuid>.json         # written by Stop hook per turn
├── .done-<uuid>                 # flag file written by Stop hook per turn
└── ...                          # plus every file from the agent folder's HEAD
```

### Why `/tmp/`, not `workspace/`?

`workspace/` is the agent folder's gitignored scratch zone — fine for one-off scripts. But a `git worktree` is a _checkout_, not scratch: it carries an index, refs in `/agent/.git/worktrees/`, and (briefly) shares working-tree state with the main checkout. Putting it under `workspace/` would mean the agent folder contains a worktree of itself, which works mechanically but is recursive and confusing. `/tmp/cx-<id>/` keeps the worktree clearly outside the agent folder.

### `AGENTS.md` discovery — relevant to delegation prompts

Codex CLI reads `AGENTS.md` files from the project root down to CWD on every session, concatenating them top-to-bottom. Because the worktree is a checkout of the agent folder, **codex will read the agent folder's own `AGENTS.md` from the worktree root**. That file is typeclaw's operator-facing manual — most of it is irrelevant to a one-shot delegation and will eat ~50K of codex's context window. If the user's task is narrow and doesn't need typeclaw's runtime context, consider passing `codex --ignore-rules` (skip user/project `.rules` files) or briefly mention "ignore AGENTS.md unless you need it" in the prompt. The skill body's flow keeps `AGENTS.md` enabled by default — only reach for `--ignore-rules` when a delegation is clearly off-topic from the surrounding codebase.

## The Stop hook

Codex CLI fires a `Stop` hook every time it finishes responding — turn-end, not session-end. The hook runs an arbitrary shell command with the lifecycle event payload (JSON) on stdin. We use this as the done-signal: the hook writes the payload to a sentinel file and touches a `.done` marker, and your polling loop watches for the marker.

**The hook is pre-baked into the container image.** When `docker.file.codexCli: true`, the Dockerfile install layer writes TWO hook scripts and a hooks-config file:

- `/usr/local/bin/typeclaw-cx-session-start-hook` — fires once at session start. Reads the SessionStart event JSON from stdin, extracts `session_id`, validates it as a UUID, and writes `$PWD/.session-id` (atomically, temp-then-rename) containing that UUID.
- `/usr/local/bin/typeclaw-cx-stop-hook` — fires every turn. Reads the Stop event JSON from stdin, extracts the same `session_id`, and writes per-session files: `$PWD/sentinel-<session_id>.json` atomically and `$PWD/.done-<session_id>`. The script uses `$PWD` (the literal cwd Codex CLI was invoked with — set by the operator's `tmux new-session -c /tmp/cx-<id>`) rather than any `CODEX_PROJECT_DIR` env var that may exist on a future version, for the same reason the Claude Code hooks avoid `$CLAUDE_PROJECT_DIR`: project-root resolution can land outside the worktree inside a `git worktree`.
- `~/.codex/hooks.json` — user-level (global) Codex CLI hooks config that registers both hooks for every `codex` invocation in the container. Built at build time via `JSON.stringify` so the shape never drifts. Both hooks use exec form (`args: []`) so Codex CLI invokes them via `execvp` directly (kernel-handled shebang, no shell tokenization).

You do **not** write any of these files. The shape of the JSON is the single most failure-prone part of a hook-driven delegation (Codex CLI silently ignores unknown keys, so wrong-shape configs would let the polling loop run to its wall-clock budget without ever firing the hook), and the only reliable fix is to keep the JSON out of LLM hands entirely.

### Per-session filenames — race safety

The sentinel and `.done` filenames carry the session UUID — `sentinel-<uuid>.json` and `.done-<uuid>` — so two `codex` sessions sharing a cwd cannot collide on a fixed `sentinel.json`. You learn the UUID one of two ways:

1. **Fast path: read `.session-id` after spawning codex.** The SessionStart hook writes it on session start. Works most of the time for Codex (unlike Claude Code, Codex's SessionStart fires before any trust dialog because the trust dialog is a per-directory prompt in the TUI loop, not a wedge that suppresses the hook).
2. **Discovery path: read it from the first Stop sentinel.** After sending the first prompt, glob `.done-*` for new files. The first one's UUID becomes `cx_session_id`. Use this as the fallback if `.session-id` doesn't appear within ~3 seconds of the SessionStart matcher window.

In both cases, **assume `cx_session_id` can rotate mid-delegation** — Codex CLI's hook system may add a `compact` SessionStart source in the future the way Claude Code did. Your polling loop should handle this: if you see a new `.done-<different-uuid>` appear, update `cx_session_id` to the new value. The cost of supporting rotation is small (a one-line check); the cost of NOT supporting it is a polling-loop timeout if upstream ever ships compaction.

**Do NOT try to pre-generate the UUID and pass it via any CLI flag.** Codex CLI doesn't document a `--session-id` flag for the interactive TUI; even if one exists, the hook payload UUID is the source of truth and the only reliable read.

If you see `$PWD/.session-id` containing the literal string `malformed`, or `$PWD/sentinel-malformed.json` appearing instead of your expected file, a hook fired but couldn't extract a UUID-shape `session_id` from the event payload (malformed JSON, missing field, or an upstream schema change). Read the file to diagnose; surface to the user.

### Verifying the global hooks

Verify both hooks are wired correctly in the container before the first delegation of a session:

```sh
test -x /usr/local/bin/typeclaw-cx-stop-hook && \
  test -x /usr/local/bin/typeclaw-cx-session-start-hook && \
  jq -e '
    .hooks.Stop[0].hooks[0].command == "/usr/local/bin/typeclaw-cx-stop-hook"
    and .hooks.Stop[0].hooks[0].args == []
    and .hooks.SessionStart[0].hooks[0].command == "/usr/local/bin/typeclaw-cx-session-start-hook"
    and .hooks.SessionStart[0].hooks[0].args == []
  ' "$HOME/.codex/hooks.json"
```

Three distinct failure modes if it fails:

| Symptom                                                | Cause                                                               | Remediation                                                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `test -x …` fails                                      | Hook script missing                                                 | `docker.file.codexCli` is off, or image built before this layer landed → `typeclaw start --build`                                    |
| Scripts present, `jq` fails                            | `$HOME/.codex/hooks.json` was overwritten or bind-mounted           | Check `cat ~/.codex/hooks.json` for user-mounted config; if so, the operator's hooks won't fire and the delegation cannot proceed    |
| Scripts + hooks.json correct, no sentinel ever appears | Hooks failing at runtime (trust skip, schema mismatch, permissions) | Inspect `ls -la /tmp/cx-<id>/.cx-stop-hook-in.*` to see if hooks fired at all, and read any `sentinel-malformed.json` for diagnostic |

Don't try to write the hook config yourself — the operator subagent doesn't have the right tools to do it reliably, which is exactly the failure mode this layout was built to eliminate.

### Hook trust prompt

Codex CLI prompts the user to **trust** a hook the first time it's loaded — a security feature that gates arbitrary command execution from third-party `hooks.json` files. For the operator-controlled flow, you can either (a) accept the trust prompt at runtime via the dialog-polling loop below, or (b) bypass it for automation by adding `--dangerously-bypass-hook-trust` to the `codex` invocation (the typeclaw-shipped hooks were vetted at Dockerfile-build time, so this bypass is safe by construction). The skill body's spawn uses option (a) by default — keep the trust review in the loop unless you're running a high-volume scripted delegation where the prompt is pure friction.

The full schema of the Stop event (every field Codex CLI populates, including `last_assistant_message` and `transcript_path`) is in `references/stop-hook.md`.

## Driving the session

The minimum protocol — translate to your actual tool calls:

1. Create the worktree.
2. `tmux new-session -d -s cx-<id> -c /tmp/cx-<id> codex`. Do not pass any `--session-id` flag (the hook payload UUID is the source of truth).
3. Wait ~3 seconds for the TUI to initialize.
4. **Clear startup dialogs (BEFORE sending the task prompt).** Codex's onboarding has at most three runtime prompts: the Auth picker (suppressed when `OPENAI_API_KEY` is in env OR `~/.codex/auth.json` exists), the TrustDirectory prompt (fires once per new cwd, so EVERY fresh `/tmp/cx-<id>/` triggers it), and the hook trust prompt (fires once per `~/.codex/hooks.json` change). Run this as a **loop**, not a one-shot: clearing one dialog can immediately reveal the next, and you must keep polling until codex's actual input prompt is visible (it renders a bottom-of-pane composer with a `▌` or similar prompt indicator).

   The three known modals, with the exact keystrokes for each:
   - **Auth picker** — "Sign in to Codex" with options to pick ChatGPT OAuth, Device code, or API key. If this fires despite `OPENAI_API_KEY` being set, the env var isn't being read — abort with `Ctrl-c` (or `/exit`) and surface to the user. Do NOT attempt to navigate the picker on the user's behalf.

   - **TrustDirectory** — "Do you trust the files in this directory?" Options are `[Yes, trust] [No, exit]` with focus on **Yes** by default. Resolution: bare `tmux send-keys -t cx-<id> Enter`. Always verify the pane text matches the trust dialog before pressing Enter.

   - **Hook trust** — "A new hook configuration has been detected at ~/.codex/hooks.json. Trust these hooks?" Options are `[Yes, trust] [No, decline]` with focus on **Yes** by default. Resolution: bare `tmux send-keys -t cx-<id> Enter`. If the dialog ever appears in a session that already accepted the hook, something rewrote `hooks.json` between runs — bail.

   Loop shape (translate to your tool calls):
   1. Capture the last ~15 lines: `tmux capture-pane -t cx-<id> -p -S -15`.
   2. If the capture contains the Auth picker text → abort (do not navigate it); surface to the user.
   3. If the capture contains the TrustDirectory dialog text → `send-keys Enter`, sleep 500ms, goto 1.
   4. If the capture contains the hook trust dialog text → `send-keys Enter`, sleep 500ms, goto 1.
   5. If the capture shows the input composer (bottom-of-pane prompt indicator with no dialog text above it) → ready; exit the loop.
   6. Otherwise sleep 500ms, goto 1. Apply a wall-clock budget of ~10 seconds; if the loop hasn't reached step 5 by then, abort with `/exit` and surface to the user — codex is in a state this skill doesn't model.

   Do not use a fixed 2-second wait then send the prompt — cold-start and slow-disk cases can deliver a dialog at 2.5s+, and sending the task prompt into a modal corrupts the session.

   **Safety note**: accepting TrustDirectory on a fresh `/tmp/cx-<id>/` worktree is the right call **only when its `HEAD` is the intended clean state** — typically the agent folder's last good commit on a branch the user controls. If the user just merged a third-party PR, pulled a remote branch, or checked out an untrusted ref, the worktree carries that content too and "trusting" it gives codex tool access on potentially hostile code. Before auto-accepting trust, sanity-check: if the user hasn't said something equivalent to "delegate this to Codex", or if you're not confident the current `HEAD` is one the user authored or reviewed, surface the trust dialog to them instead.

5. `tmux send-keys -t cx-<id> "<your prompt>" Enter`.
6. **Discover the session UUID.** First check `/tmp/cx-<id>/.session-id` (fast path); if it exists and is a real UUID, that's `cx_session_id`. Otherwise fall back to globbing `.done-*` for the newest unprocessed real-UUID file. On every poll, also check `tmux has-session -t cx-<id>` — if the session died, codex crashed or auth failed. If the only marker that appears is `.done-malformed`, the Stop hook fired but couldn't extract a UUID-shape `session_id` — bail and surface to the user.
7. Read `/tmp/cx-<id>/sentinel-${cx_session_id}.json`, examine `last_assistant_message`, then `rm /tmp/cx-<id>/.done-${cx_session_id}` (the SPECIFIC file you just processed, NOT a glob).
8. Decide using the multi-turn loop below. **Track which UUIDs you've already processed.** On the next poll, again pick the newest unprocessed `.done-<uuid>`. If the UUID differs from the previous `cx_session_id`, codex has rotated sessions — update `cx_session_id` to the new value and continue. Polling is edge-triggered: don't wait on `.done-${cx_session_id}` specifically.
9. When done: `tmux send-keys -t cx-<id> "/exit" Enter && sleep 1 && tmux kill-session -t cx-<id>`.

The full polling implementation, the ANSI-handling rules for `capture-pane` fallbacks, the alternate-screen vs inline TUI mode decision, and the "tmux session died unexpectedly" recovery path are in `references/tmux-driving.md`.

## The multi-turn decision loop

`Stop` fires every turn — including turns where codex paused to ask you a question, not just turns where codex finished the task. After every Stop sentinel, read `last_assistant_message` and decide:

- **Ends with a question mark, or contains "Do you want me to", "Should I", "Could you clarify"** → codex is asking a clarifying question. Compose an answer from the original task brief and `send-keys` it back. Reset the loop: `rm /tmp/cx-<id>/.done-${cx_session_id}` (the SPECIFIC file you just processed), add that UUID to your processed set, then poll for the next newest unprocessed `.done-<uuid>`.
- **Mentions a permission-style ask** ("May I run `<command>`?", "Allow me to edit `<file>`?") → answer per the task's safety constraints. Codex's default `approval_policy` is `on-request`, so it will ask before any tool with side effects. If the constraint is unclear, abort with `/exit` and surface to the user — never invent a yes/no on the user's behalf for an unbounded operation.
- **Looks like a final result** (code block + summary, or "Done.", "Here's the result.", "I've finished") → capture and `/exit`.
- **Looks like a status update mid-tool-use** ("Let me check…", "Reading the file now…") → this is a spurious Stop. `rm /tmp/cx-<id>/.done-${cx_session_id}`, add the UUID to your processed set, and keep polling.

**Hard turn cap: 8 turns per delegation.** Beyond that, either the task is too complex to delegate cleanly or codex is stuck in a loop. Abort with `/exit`, capture what you have, surface to the user with: "Codex took 8 turns without finishing — here's what it produced, what do you want to do?"

This loop is the most failure-prone part of the skill. If you find yourself uncertain whether a message is a question or a result, **default to surfacing to the user**, not to guessing. Wrong answers compound across turns.

## Capturing the output

Four sources, in order of preference:

1. **`git diff /agent main..cx-<id>`** (run from `/agent`, or use the explicit worktree path). This is the killer feature of the worktree model — the exact set of changes codex made, branch-vs-branch. Use this for code-change tasks.
2. **`git log cx-<id> --oneline main..cx-<id>`** for how codex got there (the sequence of commits). Useful when codex broke a refactor into steps you want to attribute or cherry-pick.
3. **`sentinel-<cx_session_id>.json` from the final turn** (`last_assistant_message`). The narrative summary codex gave you. Use this for analysis tasks where the answer is prose, not code.
4. **The JSONL transcript** at `transcript_path` in the sentinel. The complete conversation including intermediate tool calls. Use when the diff/log aren't enough and you need to see how codex reasoned. Schema in `references/stop-hook.md`.

For code-change tasks, the canonical pattern is:

1. Read `last_assistant_message` for the summary.
2. Run `git diff main..cx-<id> -- <files>` to see the actual changes.
3. Decide: are these changes good? If yes, either `git cherry-pick <commits>` onto the agent folder's branch OR copy the changes manually into the main checkout and commit there with proper attribution (per `typeclaw-git`).
4. Throw away the `cx-<id>` branch.

Never paste Codex's output verbatim into your reply or a commit message. Summarize, attribute ("Codex CLI's analysis: ..."), and stay accountable for the work. You delegated up; you didn't outsource ownership.

## Cleanup discipline

Cleanup is git-aware: a worktree isn't just a directory. Three steps, in order:

```sh
tmux kill-session -t cx-<id> 2>/dev/null || true
git -C /agent worktree remove --force /tmp/cx-<id>
git -C /agent branch -D cx-<id>
```

- **`tmux kill-session`** first because codex might still be holding files open. `|| true` because a clean `/exit` already killed the session.
- **`git worktree remove --force`** because the working tree may have dirty files (the sentinel, the hook script, codex's in-progress edits). `--force` skips the "uncommitted changes" check; this is correct here because we're explicitly discarding the worktree.
- **`git branch -D cx-<id>`** to delete the branch ref. Without this, `cx-<id>` lingers in `git branch -a` indefinitely. `-D` (capital) because `cx-<id>` is unmerged into anything you care about.

Always do all three, including on failure paths. Orphan worktrees show up in `git worktree list` forever, and the next delegation with the same task-id fails with "branch already exists".

Before starting a new delegation, check for orphans:

```sh
git -C /agent worktree list | grep cx-
tmux ls 2>/dev/null | grep '^cx-'
```

Kill anything you find first.

## When not to delegate

A re-statement, because this is where the skill is most often misused:

- **Trivial edits**: the round-trip cost dominates. Do it yourself.
- **Tasks needing live user visibility**: codex's tool calls don't stream back through TypeClaw. The user sees a long pause, not progress. Use your own tools.
- **Tasks where you don't have the context to brief codex**: spend tokens narrowing the problem first. A vague delegation produces a vague result.
- **Anything secret beyond `OPENAI_API_KEY` / `~/.codex/auth.json`**: codex only sees the prompt you send it and the files in its worktree. Don't try to pass secrets through the prompt — they'll land in codex's transcript and in your sentinel.

## Things you must not do

- **Do not use `codex exec` for multi-turn delegation work.** It's the single-shot non-interactive mode. The whole reason to delegate up is the multi-turn agent loop. `codex exec` is fine for a structured one-shot ("emit a summary in this JSON schema"), but at that point you might as well do it yourself with your own tools.
- **Do not run `codex` directly inside `/agent`.** Always inside `/tmp/cx-<id>/`. Running codex in the agent folder lets it mutate the live working tree and break the user's session in flight.
- **Do not skip the worktree.** Even for short delegations, the worktree is what gives you the `git diff` introspection and the rollback safety. Skipping it because "this one's small" is the path to codex accidentally committing on the wrong branch.
- **Do not share a tmux session across two delegated tasks.** Each task needs its own worktree and its own tmux session. The hook config is global (`~/.codex/hooks.json`), so sharing a worktree means two sessions race on the same `$PWD/.session-id` file.
- **Do not leave a tmux session, worktree, or branch alive after capturing the result.** All three need explicit teardown.
- **Do not push codex's branch to a remote.** `cx-<id>` is throwaway. If something useful happened, cherry-pick onto a real branch first; don't push the experimental branch directly.
- **Do not merge codex's branch into main without reviewing the diff.** The `git diff main..cx-<id>` is your review surface. Skipping the diff and merging blindly means you don't actually know what shipped.
- **Do not commit `/tmp/cx-<id>/` artifacts back to the agent folder.** The sentinel, the hook script, the captured pane content are scratch — they live in `/tmp/`, they die with `worktree remove`.
- **Do not paste Codex's output verbatim into a commit message or a user reply.** Summarize and attribute. You're accountable for the work you ship.
- **Do not put `OPENAI_API_KEY` or `~/.codex/auth.json` contents in `typeclaw.json`, in a prompt, or in any committed file.** API keys live in `.env`; OAuth credentials live in `~/.codex/auth.json` (a non-committed file under `$HOME`). Period.
- **Do not poll the JSONL transcript directly as the done-signal.** The JSONL has documented race conditions (the file can be stale when `Stop` fires). The sentinel is the reliable signal; the JSONL is for content, not lifecycle.
- **Do not write to `.env` or `~/.codex/auth.json` without `acknowledgeGuards: { nonWorkspaceWrite: true }`.** Both are in the `nonWorkspaceWrite` guard's deny set; the ack is required on every write, not just the first one.
- **Do not edit `.env` or `~/.codex/auth.json` with the `edit` tool's patch semantics.** Use read-modify-write: read the whole file, reconstruct the new content, write the whole file. A fragile `oldText` match could corrupt unrelated lines.
- **Do not run `codex login` inside the container.** It's an OAuth flow that wants a browser. The container has no display, no browser, and is often on a different machine from the user anyway. Always have the user run `codex login` on their own machine and paste the resulting `~/.codex/auth.json` back to you; never spawn it in tmux on this side.
- **Do not echo, log, or transcribe the pasted credential back to the user, into a sentinel, into a commit message, or into any message you send.** The `refresh_token` inside `~/.codex/auth.json` is a long-lived credential. Confirm receipt with "got it, validating" — never with the token itself.
- **Do not navigate Codex's Auth picker on the user's behalf.** If the picker fires (because no env var and no `auth.json` is present), the user owes you an auth step and the delegation cannot proceed. Bail and surface to the user; do not try to pick "API key" then paste anything into the in-TUI prompt.
- **Do not invent answers to Codex's clarifying questions.** If you can't derive the answer from the original task brief, surface the question to the user. Wrong answers compound across multi-turn delegations.
- **Do not exceed 8 turns per delegation.** Abort, capture what you have, surface. Long delegations almost always mean the task wasn't shaped right.
- **Do not assume `codex` exists.** If `which codex` returns empty, the `docker.file.codexCli` toggle isn't on. Tell the user, don't try to install it yourself.
- **Do not confuse `cx-<id>` (Codex) with `cc-<id>` (Claude Code) worktree/branch/session names.** They're parallel by design so the two CLIs can coexist; cross-using them would let a Codex Stop hook write a sentinel that a Claude polling loop is watching for, or vice versa.

## Cross-references

- **`references/auth-flow.md`** — both auth paths in detail: the API-key recap, the OAuth user-machine flow (what to tell the user, what their `~/.codex/auth.json` looks like, validation rules), and the failure-mode catalogue (expired subscription, wrong account, malformed paste).
- **`references/tmux-driving.md`** — full polling implementation, ANSI handling, session-died recovery, the `capture-pane` fallback details, the alternate-screen vs `--no-alt-screen` decision, the worktree-is-not-scratch distinction.
- **`references/stop-hook.md`** — complete `Stop` event JSON schema for Codex CLI, transcript JSONL schema notes, documented race conditions to handle.
- **`typeclaw-config`** — the `docker.file.codexCli` toggle that gates the install.
- **`typeclaw-claude-code`** — the parallel skill for Anthropic's Claude Code CLI. The worktree model, tmux driving, and Stop-hook discovery are all shared; the credentials, the dialog set, and the project-instruction file (`AGENTS.md` vs `CLAUDE.md`) differ.
- **`typeclaw-git`** — commit discipline for any cherry-picks or hand-copies from codex's worktree back into the agent folder.
- **`typeclaw-monorepo`** — the `workspace/` vs `packages/` distinction (this skill uses `/tmp/`, not `workspace/`, for reasons explained above).
