# Tmux driving — full reference

Deep dive for driving `claude` (interactive) through tmux. Read it when the main `SKILL.md` workflow hits an edge case: a hung session, a missing JSONL, an unexpected ANSI burst, a "tmux says session exists but claude isn't responsive" situation.

## Why tmux

The agent process has no TTY. `claude` (interactive) is a TUI that uses raw terminal modes — it reads stdin one byte at a time with echo off, draws with ANSI escapes, and refuses to start if stdin/stdout aren't terminals. Piping into `claude` (`echo "prompt" | claude`) doesn't work; the CLI detects the absence of a TTY and either falls back to `-p` semantics (no plan mode) or fails outright.

`tmux` solves this by spawning the process with a pty allocated by tmux itself. You then drive the pty via `send-keys` (write) and `capture-pane` (read). The process believes it's running interactively because, from its file descriptor's point of view, it is.

## Why `/tmp/cc-<id>` and not `workspace/cc-<id>`

The cwd of the spawned `claude` process must be the git worktree at `/tmp/cc-<id>/`, not the agent folder's `workspace/`. Three reasons:

1. **Worktree-vs-scratch:** the `cc-<id>` directory is a real git checkout managed by `git worktree`, with refs in `/agent/.git/worktrees/cc-<id>/`. Putting it under `workspace/` would mean the agent folder contains a worktree of itself, which works mechanically but is recursive and confusing.
2. **Claude's `.claude/settings.json` is read relative to cwd.** It must live at `/tmp/cc-<id>/.claude/settings.json` so claude picks up the per-task `Stop` hook.
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
- `-c /tmp/cc-<task-id>` — start directory. Must be the worktree path. Claude Code reads `.claude/settings.json` relative to its cwd; if cwd is wrong, the Stop hook will not be registered.
- `claude` — the command. Just `claude`, not `claude -p`. The interactive TUI is the whole point.

Common mistake: forgetting `-c` and getting cwd `/agent` by default. The Stop hook won't fire because `/agent/.claude/settings.json` doesn't exist (or it does, and you've accidentally polluted someone else's hook config). Worse: claude in `/agent` operates on the live working tree instead of the worktree.

## The init wait

`claude` prints a banner, performs auth verification, and renders its input box. This takes ~2–3 seconds on a warm cache, up to ~8s on cold start. You must wait for the input box to render before sending the first prompt, otherwise `send-keys` writes to a pane that isn't accepting input yet and your keystrokes are lost.

Two strategies:

1. **Fixed sleep (simple, mostly works):** `sleep 3` after spawn, then `send-keys`. Robust against typical init times; occasionally lossy on cold start.
2. **Poll for ready signal (robust):** every 500ms, `tmux capture-pane -t cc-<id> -p | tail -5` and look for an input-prompt marker. The exact marker varies by Claude Code version, but a unicode box-drawing character (`│`, `╭`, `╰`) at column 0 of the bottom rows is a reliable heuristic. Give up after 15 seconds and proceed anyway — late init is rare enough that the fixed-sleep fallback is fine.

The skill body uses the fixed sleep for simplicity. Upgrade to polling if you observe lost first prompts in practice.

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

## Polling for `.done`

The skill workflow polls the sentinel flag file, not the pane. This is the reliable path:

```sh
budget=600         # 10 minutes in seconds
elapsed=0
while [ ! -f /tmp/cc-<id>/.done ]; do
  if [ "$elapsed" -ge "$budget" ]; then
    echo "Timeout reached"
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

In your actual loop, translate to your tool calls: a check on `/tmp/cc-<id>/.done` existence, a check on `tmux has-session -t cc-<id>`, sleep, repeat. The shell snippet is illustrative.

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
- **Do not omit `-c /tmp/cc-<id>` on `new-session`.** Wrong cwd means wrong `.claude/settings.json`, and worse, claude operating on the live `/agent` working tree.
- **Do not skip the init wait.** Sending input before the TUI is ready loses the input silently.
- **Do not use `send-keys` with raw user-supplied strings without escaping.** Tmux's send-keys is mildly shell-like; embedded special chars get interpreted. Use `load-buffer + paste-buffer` for anything untrusted or complex.
- **Do not poll `capture-pane` as your primary done-signal.** Use the sentinel. `capture-pane` is for content retrieval, not lifecycle.
- **Do not kill the session with `C-c` if you can avoid it.** `/exit` is cleaner — it gives Claude Code time to flush the JSONL.
- **Do not assume `tmux has-session` returning success means claude is responsive.** A session can exist while claude is wedged. Pair with a wall-clock budget.
- **Do not `rm -rf /tmp/cc-<id>` instead of `git worktree remove`.** Pure rm leaves orphan refs in `/agent/.git/worktrees/cc-<id>/` and a dangling branch. The next delegation with the same id will fail with "branch already exists".
