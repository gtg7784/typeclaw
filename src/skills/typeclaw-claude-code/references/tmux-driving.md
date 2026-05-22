# Tmux driving — full reference

Deep dive for driving `claude` (interactive) through tmux. Read it when the main `SKILL.md` workflow hits an edge case: a hung session, a missing JSONL, an unexpected ANSI burst, a "tmux says session exists but claude isn't responsive" situation.

## Why tmux

The agent process has no TTY. `claude` (interactive) is a TUI that uses raw terminal modes — it reads stdin one byte at a time with echo off, draws with ANSI escapes, and refuses to start if stdin/stdout aren't terminals. Piping into `claude` (`echo "prompt" | claude`) doesn't work; the CLI detects the absence of a TTY and either falls back to `-p` semantics (no plan mode) or fails outright.

`tmux` solves this by spawning the process with a pty allocated by tmux itself. You then drive the pty via `send-keys` (write) and `capture-pane` (read). The process believes it's running interactively because, from its file descriptor's point of view, it is.

## Why `/tmp/cc-<id>` and not `workspace/cc-<id>`

The cwd of the spawned `claude` process must be the git worktree at `/tmp/cc-<id>/`, not the agent folder's `workspace/`. Three reasons:

1. **Worktree-vs-scratch:** the `cc-<id>` directory is a real git checkout managed by `git worktree`, with refs in `/agent/.git/worktrees/cc-<id>/`. Putting it under `workspace/` would mean the agent folder contains a worktree of itself, which works mechanically but is recursive and confusing.
2. **The global SessionStart and Stop hooks write their per-session files into cwd.** Both hook scripts read `$PWD` (the literal cwd Claude Code was invoked with) and write into it: SessionStart writes `.session-id` containing the UUID; Stop writes `sentinel-<uuid>.json` and `.done-<uuid>`. `$PWD` resolves to the worktree because `tmux new-session -c /tmp/cc-<id>` sets claude's cwd there. If cwd is the wrong place, the files land somewhere the polling loop isn't watching and the loop times out at its budget. (The hook config itself is global at `~/.claude/settings.json`, not per-worktree — see `references/stop-hook.md` for the architectural context. The hooks deliberately do NOT use Claude Code's `$CLAUDE_PROJECT_DIR` env var, which resolves to the git root of cwd — inside a worktree that's the main repo, not the worktree path; the dockerfile constant block in `src/init/dockerfile.ts` carries the rationale.)
3. **The worktree IS the codebase.** Claude can read every file at `HEAD` directly — it doesn't need a separate scratch area.

Auth has no in-container scratch directory at all — the OAuth `setup-token` flow runs on the user's machine, not in tmux here. See `references/auth-flow.md`.

## Spawning the session

The canonical spawn (per `SKILL.md`):

```sh
tmux new-session -d -s cc-<task-id> -c /tmp/cc-<task-id> claude
```

Flags worth knowing:

- `-d` — detached. The session runs in the background; your shell doesn't attach.
- `-s cc-<task-id>` — explicit session name. Required. Without `-s`, tmux picks `0`, `1`, … and a sibling delegation will clobber yours.
- `-c /tmp/cc-<task-id>` — start directory. Must be the worktree path. The global Stop hook at `~/.claude/settings.json` always fires regardless of cwd, but the hook script writes its sentinel to `$PWD`; if cwd is wrong, the sentinel lands somewhere your polling loop isn't watching.
- `claude` — the command. Just `claude`, not `claude -p`. The interactive TUI is the whole point.

Common mistake: forgetting `-c` and getting cwd `/agent` by default. The Stop hook still fires (it's global), but `sentinel.json` + `.done` end up under `/agent/`, your polling loop watches `/tmp/cc-<id>/`, and the loop times out at its wall-clock budget. Worse: claude in `/agent` operates on the live working tree instead of the worktree.

## The init wait

`claude` prints a banner, performs auth verification, and renders its input box. This takes ~2–3 seconds on a warm cache, up to ~8s on cold start. You must wait for the input box to render (and clear any startup dialogs) before sending the first prompt, otherwise `send-keys` writes to a pane that isn't accepting input yet and your keystrokes are lost.

The skill body's flow uses dialog-polling rather than a fixed sleep: every 500ms, `tmux capture-pane -t cc-<id> -p -S -15` and check for the input box (Unicode box-drawing `╭` / `╰` at column 0 of bottom rows) OR a known dialog (API key confirmation / workspace trust). Clear dialogs as they appear, exit the loop when the input box is visible. Give up after ~10s and surface to the user.

`.session-id` cannot be used as a readiness signal: per anthropics/claude-code#11519, SessionStart is SKIPPED while workspace trust is pending. The dialog-polling loop is the only reliable signal here.

## Sending input

```sh
tmux send-keys -t cc-<id> "<text>" Enter
```

Notes:

- **Quote carefully.** The text is interpreted by tmux's send-keys before reaching the pty. Embedded `"` and `\` need escaping. For complex prompts, write the prompt to a file and use `tmux load-buffer + paste-buffer` instead of `send-keys`:

  ```sh
  echo "<prompt>" > prompt.txt
  tmux load-buffer -t cc-<id> prompt.txt
  tmux paste-buffer -t cc-<id>
  tmux send-keys -t cc-<id> Enter
  ```

- **`Enter` is the literal key name**, not the text "Enter". Other useful key names: `Escape`, `Tab`, `BSpace`, `Up`, `Down`, `C-c` (Ctrl+C), `C-d` (Ctrl+D for EOF).

- **Multi-line prompts**: send the body, then `Enter`. Claude Code's input box treats `Enter` as submit, so newlines in your text become submitted lines (not multi-line input). If you need a genuinely multi-line prompt, use the paste-buffer flow above with embedded newlines.

## Discovering `cc_session_id` and polling for `.done-<session_id>`

The skill workflow does NOT pre-fetch the session UUID from `.session-id` — per anthropics/claude-code#11519, SessionStart is suppressed while workspace trust is pending, so `.session-id` may never appear before the first prompt. Instead, the operator discovers the UUID from the **newest unprocessed** Stop sentinel.

### Polling is edge-triggered, not level-triggered

A subtle correctness rule: never poll on "the current `.done-<sid>` appears." That's level-triggered and breaks when (a) an old `.done` still exists from the previous turn and (b) a new one with a different UUID appears (compaction). Instead:

1. **Track which sentinels you've already processed** (by UUID).
2. **On every poll, enumerate ALL `.done-*` files**, ignore the ones you've already processed, and pick the **newest by mtime** of what remains.
3. **Prefer real UUIDs over `malformed`**: if the newest unprocessed file is a real UUID, take it; if only `.done-malformed` remains, bail with a diagnostic.
4. **After processing**, remove the specific `.done-<uuid>` you read — don't `rm .done-*`, that wipes an in-flight new sentinel.

This shape handles three cases uniformly:

- **First turn**: no processed set; the only file is the new sentinel.
- **Normal turn N→N+1**: the new sentinel arrives, the old one was removed last iteration; pick the new one.
- **Compact mid-delegation**: a `.done-<newuuid>` appears while `.done-<oldsid>` may or may not have been cleaned; pick newest, update `cc_session_id`.

### Phase 1 — first-turn discovery (after the first prompt is sent)

```sh
budget=600         # 10 minutes in seconds for the first turn
elapsed=0
processed=""       # space-separated list of UUIDs we've already consumed
cc_session_id=""
while [ -z "$cc_session_id" ]; do
  # Newest unprocessed real .done-<uuid> wins.
  # ls -t sorts by mtime (newest first). Restrict to .done-<uuid> shape via case below.
  newest=""
  for f in $(ls -t /tmp/cc-<id>/.done-* 2>/dev/null); do
    [ -f "$f" ] || continue
    uuid="${f##*/.done-}"
    case " $processed " in *" $uuid "*) continue ;; esac
    if [ "$uuid" = "malformed" ]; then
      # Only honor malformed if there's nothing real to pick. Keep scanning;
      # if we don't see a real UUID first, fall through to the malformed-only case.
      malformed_fallback="$f"
      continue
    fi
    newest="$f"
    cc_session_id="$uuid"
    break
  done
  if [ -n "$cc_session_id" ]; then break; fi
  if [ -n "${malformed_fallback:-}" ]; then
    echo "Stop hook fired but couldn't extract a UUID-shape session_id"
    exit 1
  fi
  if [ "$elapsed" -ge "$budget" ]; then
    echo "Timeout reached — first Stop never fired"
    break
  fi
  if ! tmux has-session -t cc-<id> 2>/dev/null; then
    echo "tmux session died unexpectedly"
    break
  fi
  sleep 0.5
  elapsed=$((elapsed + 1))
done
```

(Fast-path optimization: if `/tmp/cc-<id>/.session-id` already exists when phase 1 starts — meaning trust was somehow already accepted before this session started — read it and skip the glob. The skill body explains why this rarely wins on first delegations.)

### Phase 2 — per-turn polling (turns 2 onward, after sending another prompt)

```sh
budget=600
elapsed=0
# `processed` carries over from phase 1 — add the just-consumed UUID before entering phase 2.
processed="$processed $cc_session_id"
new_sid=""
while [ -z "$new_sid" ]; do
  for f in $(ls -t /tmp/cc-<id>/.done-* 2>/dev/null); do
    [ -f "$f" ] || continue
    uuid="${f##*/.done-}"
    case " $processed " in *" $uuid "*) continue ;; esac
    if [ "$uuid" = "malformed" ]; then
      echo "Stop hook fired but couldn't extract a UUID-shape session_id"
      exit 1
    fi
    new_sid="$uuid"
    break
  done
  if [ -n "$new_sid" ]; then break; fi
  if [ "$elapsed" -ge "$budget" ]; then echo "Timeout reached"; break; fi
  if ! tmux has-session -t cc-<id> 2>/dev/null; then echo "tmux session died unexpectedly"; break; fi
  sleep 0.5
  elapsed=$((elapsed + 1))
done

if [ "$new_sid" != "$cc_session_id" ]; then
  echo "Detected session_id rotation (compact #29094): ${cc_session_id} → ${new_sid}"
  cc_session_id="$new_sid"
fi
# Read sentinel for this turn:
cat "/tmp/cc-<id>/sentinel-${cc_session_id}.json"
# After deciding what to do next, remove ONLY this turn's marker (not a glob):
rm -f "/tmp/cc-<id>/.done-${cc_session_id}"
```

In your actual loop, translate to your tool calls. The shell snippets are illustrative.

### Why edge-triggered, not level-triggered

The previous version of this snippet was level-triggered (`while [ ! -f .done-${cc_session_id} ]`), which has two failure modes:

- **Compact rotation while the old marker still exists**: if the operator hasn't yet `rm`'d `.done-<old>` when claude compacts and fires Stop with `.done-<new>`, the level-triggered predicate is FALSE (old still exists), the inner rotation-check loop never runs, and the operator never notices the new UUID. The new sentinel sits unread; the operator's next `rm .done-<old>` removes the stale marker; the polling loop now blocks forever waiting for `.done-<old>` to reappear.
- **First-turn discovery picking the wrong file**: `for f in .done-*` iterates in shell glob order (lexicographic). If two `.done-*` exist (operator crashed mid-cleanup of a prior turn, or compact fired immediately), the lower-UUID-prefix file wins. Newest-by-mtime is causally correct; shell-glob order is not.

If `/tmp/cc-<id>/sentinel-malformed.json` or `/tmp/cc-<id>/.done-malformed` appears AND no real UUID file appears, a hook fired but session_id extraction failed (malformed JSON, missing field, or a future upstream schema change). Read `sentinel-malformed.json` to diagnose and surface to the user — this is not a recoverable state from the operator's side.

### Why 500ms cadence

- Faster polling (50–100ms) wastes CPU and is invisible to the user; the user's perception starts caring around 1s.
- Slower polling (2s+) adds visible latency to the multi-turn loop — every Stop adds up to 2s of pure wait.
- 500ms is the sweet spot: invisible latency, minimal CPU, plenty of headroom for short turns.

### Session-died recovery

`tmux has-session` returns non-zero when the session is gone. Three reasons:

1. **Claude crashed**: assertion failure, OOM, segfault. `capture-pane` before tmux GC'd the session would show a stack trace. After GC, the session is just gone; you can't recover the pane content.
2. **Auth failed**: `claude` exited cleanly with "API key invalid" or similar. Pane would have shown the error briefly before the process exited.
3. **User killed it externally**: someone ran `tmux kill-session -t cc-<id>` outside your control.

Recovery: surface to the user with whatever you have — `git diff main..cc-<id>` (which still works because the branch exists), `sentinel.json` from any prior turn, the JSONL if it exists. Then clean up: `git worktree remove --force /tmp/cc-<id>` + `git branch -D cc-<id>`. Ask whether to retry.

## Capturing the pane (fallback path)

When the JSONL is missing or you need to see what the TUI showed:

```sh
tmux capture-pane -t cc-<id> -p -S - -E -
```

Flags:

- `-p` — print to stdout (default is to copy to a tmux buffer).
- `-S -` — start from the beginning of the scrollback.
- `-E -` — end at the current line.
- Without `-S -E`, you only capture the visible pane (rows × cols), losing everything that scrolled off.

The captured content includes ANSI escape codes by default. Pass `-e` to preserve them explicitly (rarely useful) or omit and strip via a regex after capture: `s/\x1b\[[0-9;]*[a-zA-Z]//g`.

### ANSI gotchas

- **Progress spinners redraw the same line.** Capture-pane shows the final state of each cell, so spinners look harmless. But mid-capture, if claude is actively redrawing, you may catch a partial frame. Re-capture after `Stop` for a stable view.
- **Box-drawing characters** for the input box and message frames are Unicode (`╭ ╮ ╰ ╯ │ ─`). They render fine in modern terminals but mangle in some text post-processing. If you're showing pane content to the user via TypeClaw's TUI, just preserve as-is — Bun's stdout handles UTF-8.
- **Color codes**: standard 8-color (`\x1b[31m` etc.) and 256-color (`\x1b[38;5;Nm`). The strip regex above handles both.

## Cleaning up

```sh
tmux send-keys -t cc-<id> "/exit" Enter
sleep 1
tmux kill-session -t cc-<id> 2>/dev/null || true
git -C /agent worktree remove --force /tmp/cc-<id>
git -C /agent branch -D cc-<id>
```

- `/exit` is Claude Code's built-in exit command. Cleaner than `C-c` — it lets the CLI flush the JSONL and close cleanly.
- `sleep 1` gives the CLI time to flush. Skip it and you may lose the last few JSONL lines.
- `kill-session ... || true` because the session may have already exited cleanly after `/exit`.
- `worktree remove --force` because the working tree has un-cherry-picked changes (claude's edits + the sentinel + the hook). `--force` is correct here because we're explicitly discarding.
- `branch -D` to delete the throwaway branch. `-D` (capital) because `cc-<id>` is unmerged into anything you care about.

## Things you must not do in tmux driving

- **Do not omit `-s <name>` on `new-session`.** Anonymous sessions race across delegations.
- **Do not omit `-c /tmp/cc-<id>` on `new-session`.** The global Stop hook writes its sentinel into `$PWD`; wrong cwd means the sentinel lands somewhere your polling loop isn't watching. Worse: claude in `/agent` operates on the live working tree instead of the worktree.
- **Do not skip the init wait.** Sending input before the TUI is ready loses the input silently.
- **Do not use `send-keys` with raw user-supplied strings without escaping.** Tmux's send-keys is mildly shell-like; embedded special chars get interpreted. Use `load-buffer + paste-buffer` for anything untrusted or complex.
- **Do not poll `capture-pane` as your primary done-signal.** Use the sentinel. `capture-pane` is for content retrieval, not lifecycle.
- **Do not kill the session with `C-c` if you can avoid it.** `/exit` is cleaner — it gives Claude Code time to flush the JSONL.
- **Do not assume `tmux has-session` returning success means claude is responsive.** A session can exist while claude is wedged. Pair with a wall-clock budget.
- **Do not `rm -rf /tmp/cc-<id>` instead of `git worktree remove`.** Pure rm leaves orphan refs in `/agent/.git/worktrees/cc-<id>/` and a dangling branch. The next delegation with the same id will fail with "branch already exists".
