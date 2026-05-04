---
name: typeclaw-channel-slack
description: Use this skill BEFORE every `channel_reply` or `channel_send` call whose adapter is `slack-bot`. Triggers include any time the session origin is a Slack channel/DM/thread, any mention of "Slack", "mrkdwn", "Slack formatting", or seeing literal `**bold**`/`##`/`| table |` artifacts in a previous reply that should have rendered. Slack does NOT render GitHub-flavored markdown — `**bold**`, `## heading`, `[label](url)`, and `| table |` come through as raw text and look broken. Read this skill once at the start of any Slack-routed session, then write replies in Slack mrkdwn instead of GFM.
---

# typeclaw-channel-slack

Slack renders messages with its own dialect called **mrkdwn**, not GitHub-flavored markdown. The default LLM habit (emit GFM with `**bold**`, `## headings`, `[label](url)`, markdown tables) produces literal junk on Slack — observed in production as `**작성자**` rendering as `**작성자**`, `## Huxley` as `## Huxley`, and pipe-tables coming through as raw `|` characters.

This skill exists because Slack mrkdwn is small, weird, and easy to get right once you know the seven rules below. Read it before you reply, not after the user complains.

## The seven rules

| Want            | Slack mrkdwn           | Don't write                        |
| --------------- | ---------------------- | ---------------------------------- |
| **bold**        | `*bold*`               | `**bold**` ← renders literally     |
| _italic_        | `_italic_`             | `*italic*` ← that's bold on Slack  |
| ~strike~        | `~strike~`             | `~~strike~~` ← renders literally   |
| `inline code`   | `` `inline code` ``    | (same)                             |
| code block      | ` ```code``` `         | (same)                             |
| > quote         | `> quote`              | (same)                             |
| link with label | `<https://url\|label>` | `[label](url)` ← renders literally |

## What Slack does NOT have

- **No headings.** `#`, `##`, `###` render as literal `#`/`##`/`###`. Use `*Section name*` on its own line for visual emphasis instead.
- **No tables.** `| col1 | col2 |` renders as literal pipes. Flatten to a bulleted list or plain prose. If structured data really matters, post a code block (` ```...``` `) with aligned columns.
- **No nested lists in mrkdwn.** Single-level bullets (`- item` or `* item`) work; nested indentation does not render the way GFM nests.
- **No fenced-code language hints.** ` ```python ` shows the literal `python` on the first line. Either omit the language or accept the visible tag.
- **No HTML.** No `<br>`, no `<p>`, no entities.

## Mentions

- **User**: `<@U_USER_ID>` — Slack user IDs always start with `U` (or `W` for some org accounts). Get them from the inbound message author or `agent-slack user lookup`.
- **Channel**: `<#C_CHAN_ID>` — channel IDs start with `C` (public), `G` (private group), or `D` (DM).
- **Usergroup / subteam**: `<!subteam^S_GROUP_ID>` — these are the `@team-name` mentions.
- **Special**: `<!here>`, `<!channel>`, `<!everyone>` — use sparingly, they ping everyone present.

The inbound message stream from `slack-bot` adapter already uses these forms in the `text` field, so when you echo or quote a user, copy their mention syntax verbatim — don't try to "render" it.

## Putting it together

A reply that would look correct in GitHub but broken on Slack:

```
## Summary

I checked the **deployment** logs and found a `503` from `[the API](https://api.example.com)`.

| Service | Status |
|---------|--------|
| auth    | OK     |
| billing | DOWN   |

cc: @alice
```

Rewritten in Slack mrkdwn:

```
*Summary*

I checked the *deployment* logs and found a `503` from <https://api.example.com|the API>.

• auth — OK
• billing — DOWN

cc: <@U0ALICE>
```

## When to skip mrkdwn entirely

If the content is mostly free-form prose with no formatting needs, just write plain text. Slack mrkdwn is opt-in per character — text without any of the special markers above renders identically to what you typed. The failure mode this skill prevents is reaching for GFM out of habit when no formatting was actually needed.

## What this skill does NOT cover

- **Block Kit** (rich JSON-based layouts with buttons, dropdowns, sections). The `channel_reply` / `channel_send` tools take plain text only — Block Kit is not exposed. If a user asks for buttons or interactive elements, tell them the current channels subsystem doesn't support Block Kit.
- **Discord formatting.** Discord renders most GFM correctly (`**bold**` works, `## heading` works since 2023). Use `typeclaw-channel-discord` if/when that skill exists; otherwise default GFM is mostly safe on Discord.
- **Channel Talk, Telegram, KakaoTalk, etc.** Different platforms, different rules. Each gets its own skill when needed.
