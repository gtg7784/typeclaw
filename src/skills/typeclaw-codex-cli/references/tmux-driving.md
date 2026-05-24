# Tmux driving — full reference (Codex CLI)

Deep dive for driving `codex` (interactive) through tmux. Read it when the main `SKILL.md` workflow hits an edge case: a hung session, a missing JSONL, an unexpected ANSI burst, a "tmux says session exists but codex isn't responsive" situation.

The shape of this reference is intentionally a mirror of `typeclaw-claude-code`'s `references/tmux-driving.md`. The differences are noted inline; everything not flagged is the same.

## Why tmux

The agent process has no TTY. `codex` (interactive) is a TUI built on `ratatui` + `crossterm` that uses raw terminal modes — it reads stdin one byte at a time with echo off, draws with ANSI escapes, and refuses to start sensibly if stdin/stdout aren't terminals. Piping into `codex` doesn't work; the CLI detects the absence of a TTY and either falls back to non-interactive semantics or fails outright.

`tmux` solves this by spawning the process with a pty allocated by tmux itself. You then drive the pty via `send-keys` (write) and `capture-pane` (read).

## Why `/tmp/cx-<id>` and not `workspace/cx-<id>`

Same reasoning as Claude Code's `cc-<id>`:

1. **Worktree-vs-scratch:** the `cx-<id>` directory is a real git checkout managed by `git worktree`, with refs in `/agent/.git/worktrees/cx-<id>/`. Putting it under `workspace/` would mean the agent folder contains a worktree of itself, which works mechanically but is recursive and confusing.
2. **The global SessionStart and Stop hooks write their per-session files into cwd.** Both hook scripts read `$PWD` (the literal cwd Codex CLI was invoked with) and write into it: SessionStart writes `.session-id` containing the UUID; Stop writes `sentinel-<uuid>.json` and `.done-<uuid>`. `$PWD` resolves to the worktree because `tmux new-session -c /tmp/cx-<id>` sets codex's cwd there.
3. **The worktree IS the codebase.** Codex can read every file at `HEAD` directly — it doesn't need a separate scratch area.

The `cx-` prefix (vs Claude Code's `cc-`) keeps the two CLIs' worktrees, branches, and tmux sessions in parallel namespaces. An agent running both can delegate concurrently without collision; `git worktree list` shows both kinds clearly; `tmux ls` is unambiguous.

## Spawning the session

The canonical spawn (per `SKILL.md`):

```sh
tmux new-session -d -s cx-<task-id> -c /tmp/cx-<task-id> codex
```

Flags worth knowing:

- `-d` — detached. The session runs in the background; your shell doesn't attach.
- `-s cx-<task-id>` — explicit session name. Required. Without `-s`, tmux picks `0`, `1`, … and a sibling delegation will clobber yours.
- `-c /tmp/cx-<task-id>` — start directory. Must be the worktree path. The global Stop hook at `~/.codex/hooks.json` always fires regardless of cwd, but the hook script writes its sentinel to `$PWD`; if cwd is wrong, the sentinel lands somewhere your polling loop isn't watching.
- `codex` — the command. Just `codex`, not `codex exec`. The interactive TUI is the whole point.

Common mistakes:

- Forgetting `-c` and getting cwd `/agent` by default. The Stop hook still fires (it's global), but `sentinel.json` + `.done` end up under `/agent/`, your polling loop watches `/tmp/cx-<id>/`, and the loop times out at its wall-clock budget. Worse: codex in `/agent` operates on the live working tree instead of the worktree.
- Passing flags Codex CLI doesn't recognize. Codex is a Rust binary with a strict clap parser — unknown flags fail at startup, not silently.

### Alternate-screen vs inline mode

Codex CLI's TUI defaults to **alternate-screen mode** (the same mode `vim` uses) — it takes over the entire terminal and restores the previous screen on exit. This means `tmux capture-pane -S -` only captures what's currently visible, not the full conversation history.

For our workflow this is fine: we use the Stop sentinel as the done-signal, not pane-content parsing. But if you ever need to capture the full TUI history (e.g. for a post-mortem when the JSONL is missing), spawn codex with `--no-alt-screen`:

```sh
tmux new-session -d -s cx-<id> -c /tmp/cx-<id> codex --no-alt-screen
```

`--no-alt-screen` runs the TUI inline, preserving terminal scrollback. The trade-off is that the rendering is slightly less stable (the TUI's redraws collide with normal scrollback flow), but `capture-pane -S -` will then see the full history.

Default to alternate-screen mode (no flag); reach for `--no-alt-screen` only when you genuinely need scrollback capture for debugging.

## The init wait

`codex` prints a brief Welcome animation, then renders its TUI. The animation takes ~1 second; after that the input composer appears immediately if no dialogs fire, or one or more dialog modals appear in sequence. You must wait for the input composer (and clear any dialogs) before sending the first prompt.

The skill body's flow uses dialog-polling rather than a fixed sleep: every 500ms, `tmux capture-pane -t cx-<id> -p -S -15` and check for the input composer (bottom-of-pane prompt indicator) OR a known dialog (Auth picker / TrustDirectory / hook trust). Clear dialogs as they appear, exit the loop when the input composer is visible. Give up after ~10s and surface to the user.

Unlike Claude Code, Codex's `.session-id` IS a reliable readiness signal in most cases: Codex's SessionStart hook does NOT get suppressed while the TrustDirectory dialog is pending (different upstream architecture than Claude Code's #11519 issue). The fast path — read `.session-id` after ~1 second — usually wins. But the dialog-polling loop is still required to clear TrustDirectory before sending the first prompt; otherwise the prompt is interpreted as a dialog answer.

## Sending input

```sh
tmux send-keys -t cx-<id> "<text>" Enter
```

Notes:

- **Quote carefully.** The text is interpreted by tmux's send-keys before reaching the pty. Embedded `"` and `\` need escaping. For complex prompts, write the prompt to a file and use `tmux load-buffer + paste-buffer` instead of `send-keys`:

  ```sh
  echo "<prompt>" > prompt.txt
  tmux load-buffer -t cx-<id> prompt.txt
  tmux paste-buffer -t cx-<id>
  tmux send-keys -t cx-<id> Enter
  ```

- **Bracketed paste is enabled** by default in Codex's TUI (`EnableBracketedPaste` in `tui.rs`), so `paste-buffer` content arrives intact even with newlines.

- **`Enter` is the literal key name**, not the text "Enter". Other useful key names: `Escape`, `Tab`, `BSpace`, `Up`, `Down`, `C-c` (Ctrl+C), `C-d` (Ctrl+D for EOF). Codex's composer also honors `Ctrl-M` as submit (configurable per `tui.keymap.composer.submit` in `~/.codex/config.toml`, but our flow assumes the default).

- **Multi-line prompts**: send the body, then `Enter`. Codex's composer treats Enter as submit by default, so newlines in your text become submitted lines. For genuinely multi-line input, use the paste-buffer flow above — bracketed paste passes the newlines through to the composer's input buffer without submitting until you press Enter explicitly.

## Discovering `cx_session_id` and polling for `.done-<session_id>`

Same edge-triggered polling pattern as Claude Code. Track which sentinels you've already processed by UUID; on every poll, enumerate ALL `.done-*` files, ignore the ones you've already processed, and pick the **newest by mtime** of what remains.

### Phase 1 — first-turn discovery

Fast path: after spawning codex and waiting ~1s, check `/tmp/cx-<id>/.session-id`. If it exists and contains a real UUID, that's `cx_session_id`. Otherwise fall through to the same first-turn polling as Claude Code (translate to your tool calls; the shell snippet is illustrative):

```sh
budget=600
elapsed=0
processed=""
cx_session_id=""
# Fast path
if [ -f /tmp/cx-<id>/.session-id ]; then
  candidate="$(cat /tmp/cx-<id>/.session-id 2>/dev/null)"
  case "$candidate" in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-*) cx_session_id="$candidate" ;;
    malformed) echo "SessionStart fired but session_id was bad" ; exit 1 ;;
  esac
fi
# Discovery path (fallback or wait for the first Stop)
while [ -z "$cx_session_id" ]; do
  newest=""
  for f in $(ls -t /tmp/cx-<id>/.done-* 2>/dev/null); do
    [ -f "$f" ] || continue
    uuid="${f##*/.done-}"
    case " $processed " in *" $uuid "*) continue ;; esac
    if [ "$uuid" = "malformed" ]; then
      malformed_fallback="$f"
      continue
    fi
    newest="$f"
    cx_session_id="$uuid"
    break
  done
  if [ -n "$cx_session_id" ]; then break; fi
  if [ -n "${malformed_fallback:-}" ]; then
    echo "Stop hook fired but couldn't extract a UUID-shape session_id"
    exit 1
  fi
  if [ "$elapsed" -ge "$budget" ]; then echo "Timeout reached"; break; fi
  if ! tmux has-session -t cx-<id> 2>/dev/null; then echo "tmux session died"; break; fi
  sleep 0.5
  elapsed=$((elapsed + 1))
done
```

### Phase 2 — per-turn polling (turns 2 onward)

Same shape as Claude Code's phase 2. `processed` carries over from phase 1; add the just-consumed UUID before entering phase 2. On every iteration, glob `.done-*`, pick newest unprocessed real-UUID, update `cx_session_id` if it differs (rotation), read the sentinel, `rm` ONLY the specific `.done-<uuid>` you processed.

```sh
budget=600
elapsed=0
processed="$processed $cx_session_id"
new_sid=""
while [ -z "$new_sid" ]; do
  for f in $(ls -t /tmp/cx-<id>/.done-* 2>/dev/null); do
    [ -f "$f" ] || continue
    uuid="${f##*/.done-}"
    case " $processed " in *" $uuid "*) continue ;; esac
    if [ "$uuid" = "malformed" ]; then echo "bad session_id"; exit 1; fi
    new_sid="$uuid"
    break
  done
  if [ -n "$new_sid" ]; then break; fi
  if [ "$elapsed" -ge "$budget" ]; then echo "Timeout"; break; fi
  if ! tmux has-session -t cx-<id> 2>/dev/null; then echo "tmux died"; break; fi
  sleep 0.5
  elapsed=$((elapsed + 1))
done

if [ "$new_sid" != "$cx_session_id" ]; then
  echo "Detected session_id rotation: ${cx_session_id} → ${new_sid}"
  cx_session_id="$new_sid"
fi
cat "/tmp/cx-<id>/sentinel-${cx_session_id}.json"
rm -f "/tmp/cx-<id>/.done-${cx_session_id}"
```

### Why edge-triggered, not level-triggered

Same reasoning as Claude Code. Level-triggered polling on a fixed `.done-<sid>` filename breaks on session rotation and on the "old marker still exists when new one arrives" race. Newest-by-mtime + processed-set is the only correct pattern.

### Why 500ms cadence

- Faster polling (50–100ms) wastes CPU and is invisible to the user.
- Slower polling (2s+) adds visible latency.
- 500ms is the sweet spot — same calibration as Claude Code, same reasoning.

### Session-died recovery

`tmux has-session` returns non-zero when the session is gone. Three reasons:

1. **Codex crashed**: panic, segfault. `capture-pane` before tmux GC'd would show the panic message.
2. **Auth failed**: `codex` exited cleanly with "Unauthorized" or similar. Pane would have shown the error briefly.
3. **User killed it externally**: someone ran `tmux kill-session -t cx-<id>` outside your control.

Recovery: surface to the user with whatever you have — `git diff main..cx-<id>` (which still works because the branch exists), `sentinel.json` from any prior turn, the JSONL if it exists. Then clean up: `git worktree remove --force /tmp/cx-<id>` + `git branch -D cx-<id>`. Ask whether to retry.

## Capturing the pane (fallback path)

When the JSONL is missing or you need to see what the TUI showed:

```sh
tmux capture-pane -t cx-<id> -p -S - -E -
```

Flags:

- `-p` — print to stdout.
- `-S -` — start from the beginning of the scrollback.
- `-E -` — end at the current line.

If codex was spawned in alternate-screen mode (the default), `-S -` only captures the current screen. For full history, spawn with `--no-alt-screen`.

### ANSI gotchas

- **Codex uses crossterm + ratatui** with bracketed paste, focus tracking, and keyboard enhancement modes enabled. Captures will contain ANSI escapes for color, cursor positioning, and bracketed-paste markers (`\x1b[200~` / `\x1b[201~`).
- **Progress indicators** in Codex's tool-use UI redraw in place. Captures show the final state of each cell.
- **Box-drawing characters** for input frames are Unicode (`╭ ╮ ╰ ╯ │ ─`). Preserve as UTF-8.
- **Color codes**: standard 8-color and 256-color. Strip with `s/\x1b\[[0-9;]*[a-zA-Z]//g` if you need plain text.

## Cleaning up

```sh
tmux send-keys -t cx-<id> "/exit" Enter
sleep 1
tmux kill-session -t cx-<id> 2>/dev/null || true
git -C /agent worktree remove --force /tmp/cx-<id>
git -C /agent branch -D cx-<id>
```

- `/exit` is Codex CLI's built-in exit command. Cleaner than `C-c` — it lets the CLI flush the JSONL and close cleanly.
- `sleep 1` gives the CLI time to flush. Skip it and you may lose the last few JSONL lines.
- `kill-session ... || true` because the session may have already exited cleanly after `/exit`.
- `worktree remove --force` because the working tree has un-cherry-picked changes. `--force` is correct here because we're explicitly discarding.
- `branch -D` to delete the throwaway branch.

## Things you must not do in tmux driving

- **Do not omit `-s <name>` on `new-session`.** Anonymous sessions race across delegations.
- **Do not omit `-c /tmp/cx-<id>` on `new-session`.** The global Stop hook writes its sentinel into `$PWD`; wrong cwd means the sentinel lands somewhere your polling loop isn't watching. Worse: codex in `/agent` operates on the live working tree instead of the worktree.
- **Do not skip the init wait.** Sending input before the TUI is ready loses the input silently — or worse, the input lands inside a dialog modal and gets interpreted as a yes/no answer.
- **Do not use `send-keys` with raw user-supplied strings without escaping.** Tmux's send-keys is mildly shell-like; embedded special chars get interpreted. Use `load-buffer + paste-buffer` for anything untrusted or complex.
- **Do not poll `capture-pane` as your primary done-signal.** Use the sentinel. `capture-pane` is for content retrieval, not lifecycle.
- **Do not kill the session with `C-c` if you can avoid it.** `/exit` is cleaner.
- **Do not assume `tmux has-session` returning success means codex is responsive.** A session can exist while codex is wedged. Pair with a wall-clock budget.
- **Do not `rm -rf /tmp/cx-<id>` instead of `git worktree remove`.** Pure rm leaves orphan refs and a dangling branch.
- **Do not mix `cx-` and `cc-` prefixes within one delegation.** They're parallel namespaces by design — Codex sessions use `cx-`, Claude Code sessions use `cc-`. Cross-using leaves orphans in both worktree lists.
- **Do not pass `codex --no-alt-screen` reflexively.** Alternate-screen mode is the default for good reason (cleaner TUI rendering). Reach for the flag only when you need full-scrollback capture for debugging.
