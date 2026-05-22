# Stop hook — schema and gotchas

Deep dive for the `Stop` lifecycle hook that powers the done-signal. Read it when the basic hook in `SKILL.md` isn't enough — when the transcript looks stale, the sentinel is malformed, or you need to extract intermediate tool calls from the JSONL.

## What fires when

Claude Code supports several lifecycle hooks. The two relevant to delegation are:

- **`Stop`** — fires every time the _main_ agent finishes responding. This is per-turn, not per-session. A 5-turn conversation fires `Stop` five times. The "task is done" signal is just "the latest Stop, where claude's message looks like a result not a question" — that's the multi-turn decision loop in `SKILL.md`.
- **`SubagentStop`** — fires when a _sub-agent_ (Task tool, plan-mode sub-agents, etc.) finishes. Sub-agents are claude spawning claude. You don't typically need to handle this — the parent's `Stop` fires after its sub-agents are done. Configure it only if you want progress signals during a sub-agent-heavy turn.

Other hooks that exist (`PreToolUse`, `PostToolUse`, `Notification`, `SessionStart`, `SessionEnd`, `PreCompact`, etc.) are out of scope for this skill — they're useful for progress logging, command auditing, or session bookkeeping, but they're not the done-signal.

## Stop event JSON schema

The hook command receives a single JSON object on stdin. Fields observed in current Claude Code (subject to upstream churn — the docs page is at `https://docs.anthropic.com/en/docs/claude-code/hooks`):

```jsonc
{
  "session_id": "abc123…", // The Claude Code session UUID
  "transcript_path": "/root/.claude/projects/-tmp-cc-foo/abc123.jsonl",
  "cwd": "/tmp/cc-foo", // Should match your worktree path
  "permission_mode": "default", // or "plan", "bypassPermissions", etc.
  "hook_event_name": "Stop", // Literal "Stop" for this event
  "stop_hook_active": false, // True only while the hook itself runs
  "last_assistant_message": "…", // The text of claude's just-finished turn
}
```

Fields you actually use:

- **`last_assistant_message`** — your primary capture for the multi-turn decision loop. Read this from `sentinel.json`, classify (question / permission / result / spurious), act.
- **`transcript_path`** — points at the JSONL with the full conversation. Useful when `last_assistant_message` isn't enough.
- **`cwd`** — sanity check. If this isn't `/tmp/cc-<id>`, something is wrong with your tmux spawn (likely missing `-c`).
- **`session_id`** — useful for logging or if you want to correlate with the JSONL filename.

Fields you ignore:

- `permission_mode`, `stop_hook_active` — for hook-internal coordination, not delegation logic.

### SubagentStop deltas

If you ever configure a `SubagentStop` hook, expect these additional fields:

```jsonc
{
  "agent_id": "def456…",
  "agent_transcript_path": "/root/.claude/projects/-tmp-cc-foo/abc123/subagents/agent-def456.jsonl",
}
```

The schema is otherwise the same. `agent_transcript_path` is a separate JSONL per sub-agent.

## The transcript JSONL

`transcript_path` points at a JSONL file with one JSON object per line. Anthropic does not publish a formal schema — community tools (claudeoo, maury, serac) have reverse-engineered it. What you'll see:

- **`{ "type": "user", "message": { … } }`** — what you sent claude (or what the upstream parent sent, for sub-agents).
- **`{ "type": "assistant", "message": { "content": [ … ] } }`** — claude's response. `content` is an array of `{ "type": "text", "text": "…" }` and `{ "type": "tool_use", … }` objects.
- **`{ "type": "tool_use", "name": "Read", "input": { … } }`** — tool calls claude made.
- **`{ "type": "tool_result", "tool_use_id": "…", "content": "…" }`** — tool results.
- **`{ "type": "system", "subtype": "…" }`** — system events: `compact_boundary`, `turn_duration`, `stop_hook_summary`, etc.
- **`{ "type": "attachment", … }`** — file uploads or contextual attachments.

To extract claude's final text answer when `last_assistant_message` isn't enough:

```sh
# Read every assistant-text content line from the JSONL
jq -r 'select(.type == "assistant") | .message.content[] | select(.type == "text") | .text' "$transcript_path"
```

Filter further by timestamp or message-id if you only want the last turn.

## Documented race conditions

Three known races, all from upstream Claude Code issues. The skill body's design avoids them by preferring the sentinel over the JSONL; this is the reasoning if you have to debug:

1. **Stale transcript on Stop (#15813).** The `Stop` hook can fire before the last assistant message is flushed to the JSONL. If you read `transcript_path` immediately on hook fire, the last message may not be there yet. **Mitigation:** use `last_assistant_message` from the hook's stdin JSON as the primary capture; treat the JSONL as the backup, with a 1–2 second wait if it looks stale.
2. **Missing transcript file (#20612, #30217).** Some users report `transcript_path` pointing at a file that doesn't exist, especially in multi-session or concurrent-worktree setups. **Mitigation:** capture `last_assistant_message` on every Stop and accumulate it yourself if you need the full history. Falling back to `tmux capture-pane -S -` is the last-resort path.
3. **Inaccurate final token counts (#27361).** The JSONL has historically missed the final `message_stop` SSE event, causing `output_tokens` to be a mid-stream snapshot (sometimes undercounted by ~2x). **Mitigation:** don't rely on JSONL token counts for cost calculations; the Anthropic Console workspace usage is the authoritative source.

## Permission prompts vs Stop

A subtle point that confuses the multi-turn decision loop: **permission prompts do not fire `Stop`**. When claude is waiting for a "Allow this command?" yes/no, the turn isn't over — the model is waiting for the _user_ (you) to type y/n into the TUI, not waiting for a new prompt. So:

- **Permission prompt appears** → no `Stop`, no `.done`, you keep polling.
- **You answer the prompt** (via `tmux send-keys "y" Enter`) → claude continues working, eventually finishes its turn → `Stop` fires.

This is why the multi-turn loop's classification is "ends with question mark / contains 'Do you want me to'" — it's looking for _content-level_ questions claude wrote as part of its response, not permission-tool prompts. Permission prompts don't reach `last_assistant_message`; they only appear in the pane.

If you need to detect permission prompts (to auto-answer them), `capture-pane` is the only signal. Look for the literal yes/no UI affordance at the bottom of the pane. This is risky to automate — you're answering on the user's behalf for an operation you can't see the full safety implications of. Default behavior in this skill: pause polling for the sentinel, look at the pane after the budget elapses without a `.done`, and if there's a permission prompt sitting there, surface to the user rather than auto-answering.

## Things you must not do with the Stop hook

- **Do not write a per-worktree `.claude/settings.json` from operator code.** The hook is pre-baked into the image at build time (see `src/init/dockerfile.ts`, constants `TYPECLAW_CC_STOP_HOOK_PATH` and `TYPECLAW_CC_GLOBAL_SETTINGS`) precisely so the operator subagent never has to construct the JSON itself. Past delegations failed by inventing wrong shapes like `{"hooks": {"onStop": "./script.sh"}}` (wrong key — Claude Code's event name is literal `Stop`, no `on` prefix), `{"hooks": {"Stop": "./script.sh"}}` (right key, wrong value type — must be an array of matcher objects, not a string), and `{"hooks": {"Stop": [{"command": "./script.sh"}]}}` (missing the `matcher` and the inner `hooks` array — the schema is two levels of nesting, not one). All three slips silently fail: Claude Code ignores unknown keys, so the hook is never registered, `.done` is never created, and the polling loop times out at its wall-clock budget. If you ever find yourself wanting to write a per-worktree settings file, **stop** — either the global hook isn't installed (verify with the `jq` check in `SKILL.md`'s "The Stop hook" section) or you're trying to customize behavior the skill's flow doesn't anticipate. In the former case, bail to the user; in the latter, the right answer is a code change to `src/init/dockerfile.ts`, not a runtime JSON write.
- **Do not edit the in-Dockerfile hook config in a way that bypasses `JSON.stringify` + the regression test.** `TYPECLAW_CC_GLOBAL_SETTINGS` in `src/init/dockerfile.ts` is constructed via `JSON.stringify` so any structural drift fails `dockerfile.test.ts`'s `JSON.parse` regression test, not the docker build or (worse) the first failed delegation. Hand-writing the JSON as a string literal would let a typo land in production. The accepted shape is exactly `{"hooks": {"Stop": [{"matcher": "*", "hooks": [{"type": "command", "command": "..."}]}]}}`.
- **Do not set `matcher` to anything other than `"*"`.** The matcher filters by hook tool name; for `Stop`, there's no tool — `"*"` is the canonical "fire on every Stop". Other values may silently never match.
- **Do not put long-running commands in the hook.** The hook runs synchronously on the Claude Code main loop; a slow hook blocks the user's next prompt. Write the payload + touch a flag + exit. Anything heavier belongs in your polling loop, not the hook.
- **Do not skip the temp-file rename pattern.** Writing `sentinel.json` directly with `>` lets readers see partial JSON if they poll mid-write. Always `cat > sentinel.json.tmp && mv sentinel.json.tmp sentinel.json`.
- **Do not delete `transcript_path` from inside the hook.** The path is shared with `SessionEnd` and other lifecycle events; deleting it breaks downstream hooks.
- **Do not log the full hook payload to a place you don't control.** It contains `last_assistant_message`, which can contain anything claude said — including code, secrets the user pasted, or private context. Sentinel is fine (it's in `/tmp/`); piping to a shared log is not.
