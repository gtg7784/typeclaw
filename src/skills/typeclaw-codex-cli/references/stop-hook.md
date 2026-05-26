# Stop hook — schema and gotchas (Codex CLI)

Deep dive for the `Stop` lifecycle hook that powers the done-signal. Read it when the basic hook in `SKILL.md` isn't enough — when the transcript looks stale, the sentinel is malformed, or you need to extract intermediate tool calls from the JSONL.

## What fires when

Codex CLI ships a hook system that closely mirrors Claude Code's. Events relevant to delegation:

- **`Stop`** — fires every time the main agent finishes responding. Per-turn, not per-session. A 5-turn conversation fires `Stop` five times. The "task is done" signal is just "the latest Stop, where codex's message looks like a result not a question" — that's the multi-turn decision loop in `SKILL.md`.
- **`SessionStart`** — fires once when the session begins. The pre-baked `typeclaw-cx-session-start-hook` uses this to write `$PWD/.session-id` so the operator learns the session UUID before any Stop fires.
- **`SubagentStop`** — fires when a Codex subagent (Task tool invocation, plan-mode subagents) finishes. Sub-agents are codex spawning codex. You don't typically need to handle this — the parent's `Stop` fires after its subagents are done. Configure it only if you want progress signals during a subagent-heavy turn.

Other hooks that Codex CLI supports (`PreToolUse`, `PostToolUse`, `PermissionRequest`, `UserPromptSubmit`, `PreCompact`, `PostCompact`, etc.) are out of scope for this skill — they're useful for progress logging, command auditing, or session bookkeeping, but they're not the done-signal.

## Stop event JSON schema

The hook command receives a single JSON object on stdin. Fields observed in current Codex CLI (subject to upstream churn — the docs page is at `developers.openai.com/codex/hooks`):

```jsonc
{
  "session_id": "abc123…",
  "transcript_path": "/root/.codex/sessions/abc123.jsonl",
  "cwd": "/tmp/cx-foo",
  "model": "gpt-5.5",
  "hook_event_name": "Stop",
  "last_assistant_message": "…",
  "turn_id": "tu_xyz",
}
```

Fields you actually use:

- **`last_assistant_message`** — your primary capture for the multi-turn decision loop. Read this from `sentinel.json`, classify (question / permission / result / spurious), act.
- **`transcript_path`** — points at the JSONL with the full conversation. Useful when `last_assistant_message` isn't enough.
- **`cwd`** — sanity check. If this isn't `/tmp/cx-<id>`, something is wrong with your tmux spawn (likely missing `-c`).
- **`session_id`** — useful for logging or if you want to correlate with the JSONL filename. Already extracted into the sentinel filename by the hook.
- **`turn_id`** — Codex-specific (no equivalent in Claude Code's payload). Useful for correlating a Stop event with the specific assistant turn in the JSONL.

Fields you ignore:

- `model`, `hook_event_name` — fixed-per-session metadata; not useful for lifecycle decisions.

## The transcript JSONL

`transcript_path` points at a JSONL file with one JSON object per line. Codex's JSONL is similar in shape to Claude Code's but the type tags differ. Per OpenAI's docs, expect events of the form:

- **`{ "type": "thread.started", "thread_id": "..." }`** — session boot.
- **`{ "type": "turn.started" }`** — a new agent turn.
- **`{ "type": "turn.completed", "usage": { ... } }`** — turn ended.
- **`{ "type": "item.started", "item": { "type": "agent_message" | "tool_call" | ..., ... } }`** — a content/tool item began.
- **`{ "type": "item.completed", "item": { "id": "...", "type": "agent_message", "text": "..." } }`** — a content item finished.
- **`{ "type": "error", ... }`** — an error item.

To extract codex's final text answer when `last_assistant_message` isn't enough:

```sh
jq -r 'select(.type == "item.completed") | .item | select(.type == "agent_message") | .text' "$transcript_path"
```

The exact field names and item types may drift between Codex versions — confirm against `developers.openai.com/codex/noninteractive` (which documents the JSONL schema for `codex exec --json`, the same event types).

## Documented race conditions

Race conditions in Codex CLI's hook system aren't as well-documented as Claude Code's (which has a richer GitHub-issues catalog). The hook's own design — temp-file-then-rename for atomic sentinel writes, `.done` touch after the rename, per-session filenames — already defends against the main classes of race the Claude Code hook surfaces in #15813, #20612, etc. Treat these as defense-in-depth:

1. **Stale transcript on Stop**: the hook payload's `last_assistant_message` field carries the same content the JSONL eventually flushes, so prefer it over a re-read of `transcript_path` immediately on hook fire. Wait 1–2 seconds before reading the JSONL if you need it.
2. **Missing transcript file**: rare in observed practice, but possible during heavy concurrent invocations. Mitigation: capture `last_assistant_message` on every Stop and accumulate it yourself if you need the full history.
3. **Token-count drift**: Codex's `turn.completed` usage field has been observed to underreport `output_tokens` in some streaming edge cases (similar to Claude Code's #27361). Don't rely on JSONL token counts for cost calculations; the OpenAI dashboard is the authoritative source.

## Permission prompts vs Stop

Codex CLI's default `approval_policy` is `on-request`: the model asks for permission before each tool with side effects, and the user (you, via tmux) answers. **Permission prompts do not fire `Stop`** — when codex is waiting for a "Allow this command?" yes/no, the turn isn't over.

- **Permission prompt appears** → no `Stop`, no `.done`, you keep polling.
- **You answer the prompt** (via `tmux send-keys "y" Enter`) → codex continues, eventually finishes its turn → `Stop` fires.

The multi-turn loop's classification looks for content-level questions (questions codex wrote as part of its response), not permission-tool prompts. Permission prompts only appear in the pane, not in `last_assistant_message`.

If you need to detect permission prompts (to auto-answer them), `capture-pane` is the only signal. Look for the literal yes/no UI affordance. This is risky to automate. Default behavior in this skill: pause polling for the sentinel, look at the pane after the budget elapses without a `.done`, and if there's a permission prompt sitting there, surface to the user rather than auto-answering.

**Alternative — bypass permissions for vetted automation.** If you want codex to run without per-tool prompts (because the worktree is sandboxed and you've vetted the task), pass `--ask-for-approval never --sandbox workspace-write` to `codex` on spawn. This is the Codex equivalent of "give the agent unattended tool access for this delegation"; use sparingly and only when the worktree's worst-case blast radius is bounded.

## Things you must not do with the Stop hook

- **Do not write a per-worktree `~/.codex/hooks.json` from operator code.** The hook is pre-baked into the image at build time (see `src/init/dockerfile.ts`, constants `TYPECLAW_CX_STOP_HOOK_PATH` and `TYPECLAW_CX_GLOBAL_HOOKS`) precisely so the operator subagent never has to construct that JSON itself. The shape is identical to Claude Code's `settings.json` hooks block (deliberately — same nesting, same exec-form via `args: []`), but Codex's parser silently ignores unknown keys the same way Claude's does. Wrong-shape configs disable the done-signal and burn the polling loop's wall-clock budget. If you ever find yourself wanting to write a per-worktree hooks file, **stop** — either the global hook isn't installed (verify with the `jq` check in `SKILL.md`'s "The Stop hook" section) or you're trying to customize behavior the skill's flow doesn't anticipate. In the former case, bail to the user; in the latter, the right answer is a code change to `src/init/dockerfile.ts`, not a runtime JSON write.
- **Do not edit the in-Dockerfile hook config in a way that bypasses `JSON.stringify` + the regression test.** `TYPECLAW_CX_GLOBAL_HOOKS` in `src/init/dockerfile.ts` is constructed via `JSON.stringify` so any structural drift fails `dockerfile.test.ts`'s `JSON.parse` regression test, not the docker build or (worse) the first failed delegation.
- **Do not set the Stop matcher to anything other than `"*"`.** The matcher filters by hook tool name; for `Stop`, there's no tool — `"*"` is the canonical "fire on every Stop". Other values may silently never match.
- **Do not put long-running commands in the hook.** The hook runs synchronously on the Codex CLI main loop; a slow hook blocks the user's next prompt. Write the payload + touch a flag + exit. Anything heavier belongs in your polling loop, not the hook.
- **Do not skip the temp-file rename pattern.** Writing `sentinel.json` directly with `>` lets readers see partial JSON if they poll mid-write. Always temp-then-rename. The pre-baked hook script already does this — don't replace it with a per-worktree variant.
- **Do not delete `transcript_path` from inside the hook.** The path is shared with `SessionEnd` and other lifecycle events; deleting it breaks downstream hooks.
- **Do not log the full hook payload to a place you don't control.** It contains `last_assistant_message`, which can contain anything codex said — including code, secrets the user pasted, or private context. Sentinel is fine (it's in `/tmp/`); piping to a shared log is not.
- **Do not assume the JSONL event-type names are identical to Claude Code's.** They're shaped similarly but differ (`item.completed` vs `assistant`/`content[].type`). When extracting content from the JSONL, write Codex-specific `jq` filters; don't reuse Claude Code's.
