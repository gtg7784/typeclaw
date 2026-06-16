# typeclaw-plugin-tool-result-cap

The bundled tool-result-cap plugin. Caps the size of `tool.after` results before they get persisted to the session JSONL, so a single oversized tool output cannot bloat the transcript and force the full payload to round-trip to the LLM on every subsequent turn.

This plugin is **auto-loaded** by every TypeClaw agent. There is no `plugins[]` entry to add and no opt-out short of `tool-result-cap.enabled: false`. To configure it, add a `tool-result-cap` block to `typeclaw.json`.

## Why it exists

`pi-coding-agent`'s built-in tools occasionally return very large payloads that the model only needed once. Two empirically observed cases:

1. **`read` on an image file** returns the base64-encoded image inline (e.g. `{type:"image", data:"<3.2MB of base64>"}`). The model uses it on the turn it was asked for, then sees the same 3.2MB of base64 as conversation context on every subsequent prompt — until compaction fires (which is token-driven, not byte-driven, so a single fat blob may sit in context for many turns before compaction is triggered).
2. **`web_fetch` on a binary URL** (PNG, ZIP, etc.) receives the raw response body, treats it as text, and stores raw binary as a JSON-encoded string. Same effect: 100KB+ of mojibake sits in the transcript permanently.

The result is a session JSONL file that's tens of megabytes on disk but mostly one or two giant tool results, plus 3-minute first-prompt latencies after container restart because the full transcript gets re-shipped to the LLM as context.

`tool-result-cap` registers a `tool.after` hook that inspects every tool's result and, in place, replaces oversized image/text parts with a short placeholder before pi-coding-agent appends the entry to the JSONL. The cap happens at the wire-format level, so the bloat never reaches disk or the LLM in the first place.

For sessions that already contain oversized tool results from before this plugin was active (or before its limits were tightened), the **channel session factory also runs the same cap policy at rehydrate time**: just before `SessionManager.open(path)` reads the JSONL, the file is scanned for oversized `toolResult` entries and those entries are rewritten in place. The pass is idempotent and skipped entirely when `tool-result-cap.enabled` is `false`. **`typeclaw restart` is therefore the single user-facing recovery action for a poisoned channel session** — no scrubber subcommand, no manual surgery on `channels/sessions.json`.

## Config

```json
{
  "tool-result-cap": {
    "enabled": true,
    "imageMaxBytes": 262144,
    "textMaxBytes": 32768,
    "exemptTools": []
  }
}
```

| Field                           | Default  | Effect                                                                                                                                                                                                                                                                                               |
| ------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool-result-cap.enabled`       | `true`   | Master switch. When `false`, the plugin returns no hooks at all and tool results pass through untouched.                                                                                                                                                                                             |
| `tool-result-cap.imageMaxBytes` | `262144` | Maximum size (in bytes of the base64 string, not the decoded binary) for any `{type:"image"}` part in a tool result. Parts above this are replaced with a short text placeholder naming the original mime type and size. Default is ~256KB of base64 ≈ ~190KB of binary. Minimum `1024`.             |
| `tool-result-cap.textMaxBytes`  | `32768`  | Maximum length (in characters) for any `{type:"text"}` part. Parts above this are truncated: the first `textMaxBytes` characters are kept (so the LLM sees the shape of the output), and an elision marker is appended naming the byte count dropped. Default is ~32KB ≈ ~8K tokens. Minimum `1024`. |
| `tool-result-cap.exemptTools`   | `[]`     | List of tool names to skip entirely. Use when a specific tool genuinely needs to return large payloads and you can absorb the per-turn cost.                                                                                                                                                         |

All fields are **restart-required** — the plugin reads them once at boot.

## How it works

The plugin registers a single `tool.after` hook. The hook receives `event.result: ToolResult` by reference, walks `result.content`, and replaces each `ContentPart` in place when it exceeds its corresponding threshold. Mutation order is unspecified across plugins, but because the wrapper in `src/agent/plugin-tools.ts` reads the same `hookResult.content` reference after the hook chain finishes, mutations are seen by pi-coding-agent and persisted to JSONL.

The cap is per-part, not per-result, so a result with one small text part and one giant image is partly preserved (small text untouched, image elided).

Placeholders carry the literal substring `tool-result-cap:` so future agents (or human operators inspecting a session) can grep for them and recognize that the original payload was intentionally elided rather than truncated by some other layer.

## What's not capped

- `details` on tool results (an opaque structured payload provider-specific to each tool — generally small, and mutating it risks breaking tool-specific telemetry).
- Tool calls themselves (`assistant` messages with `toolUse` content). These are bounded by the LLM's own output limits.
- User messages and system prompts.

## Ordering against other bundled plugins

Plugin hook order is the order plugins are listed in `src/run/bundled-plugins.ts`. `tool-result-cap` is registered **before** `guard` so guard's `tool.after` advice (the uncommitted-changes warning) appends to the already-capped content. This means a guard advice that fires on the same call sees a small text part and a placeholder, never the original oversized payload — keeping the advice text immediately legible in the JSONL.

## What it contributes

| Kind                 | Name                          | Notes                                                                                                                                                                                                                                                                                                                       |
| -------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hook                 | `tool.after`                  | Walks `event.result.content` and replaces oversized image/text parts in place. Logs one `info` line per capped call, silent otherwise.                                                                                                                                                                                      |
| Load-time pass       | `capJsonlFileInPlace`         | Called by `src/run/channel-session-factory.ts` before `SessionManager.open(path)` on every channel-session rehydrate. Walks JSONL entries, applies the same `capToolResult` per `toolResult` message, and rewrites the file atomically (temp + rename) when any entry mutated. Idempotent; passes malformed lines verbatim. |
| Config-bridge helper | `resolveCapOptionsFromConfig` | Parses the `tool-result-cap` config block through the plugin's `configSchema` and returns the runtime `CapOptions` (or `null` when `enabled: false`). Lets non-plugin call sites share the same disable rule as the `tool.after` hook.                                                                                      |

## Tests

- `cap-result.test.ts` — pure-function unit tests for the capping logic (image replacement, text truncation, mixed parts, exempt tools, empty results, in-place mutation invariant).
- `cap-jsonl.test.ts` — load-time pass: rewrite-on-mutation, no-write-when-clean, idempotency, exemptTools respected, non-toolResult entries preserved, malformed-line passthrough, missing-file safety, multi-entry batching, text truncation in JSONL form.
- `index.test.ts` — composition tests (config schema defaults and validation, hook registration, disabled-mode short-circuit, logging on cap, silence on no-op, `resolveCapOptionsFromConfig` semantics).
