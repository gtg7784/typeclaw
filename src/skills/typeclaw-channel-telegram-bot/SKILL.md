---
name: typeclaw-channel-telegram-bot
description: "How replies sent through the `telegram-bot` channel adapter actually render in Telegram. Read this BEFORE composing a reply that contains formatting markers — `**bold**`, `*italic*`, `_italic_`, `` `code` ``, fenced code blocks (```), `[label](url)`, `~~strike~~`, `||spoiler||`, `# heading`, `- list`, `| table |`, raw `.` `!` `(` `)` `_` `*` punctuation in URLs/IDs, snake_case identifiers — and your draft is going to a Telegram chat or supergroup. Also load if a Telegram user reports your message arrived as raw markdown (literal `**asterisks**`), as garbled text with stray backslashes, or with a Telegram error like `Bad Request: can't parse entities`. Covers: which markers actually render, which ones are stripped or escaped, what Telegram has no equivalent for (headings, bulleted/numbered lists, tables — they fall through as escaped literals), how the adapter's MarkdownV2 escaping behaves, and how to keep your message readable when the rendering and the source diverge."
---

# typeclaw-channel-telegram-bot

When you reply through the `telegram-bot` channel adapter, your text does NOT go to Telegram unchanged. It goes through `toTelegramMarkdownV2` in `src/channels/adapters/telegram-bot-format.ts`, which translates the common Markdown you write into Telegram's strict **MarkdownV2** dialect and escapes every reserved char that isn't part of a recognized formatting marker. The Telegram Bot API is then called with `parse_mode: 'MarkdownV2'`.

This is necessary because Telegram's MarkdownV2 parser is unforgiving: any unescaped `_ * [ ] ( ) ~ \` > # + - = | { } . !`outside an entity returns`Bad Request: can't parse entities`and the whole message is rejected. Plain text would never crash, but then your`**bold**`would render as the literal six characters`**bold**` — which is the bug this skill exists to prevent you from re-introducing on the user side ("just write what you mean, the adapter will handle it").

## What the adapter renders

These markers translate to native Telegram formatting:

- `**bold**` → bold (renders as `*bold*` on the wire — MarkdownV2 reserves `*` for bold)
- `__bold__` → bold (when not adjacent to a word char on either side; otherwise treated as literal underscores so `my__var__name` stays a snake_case identifier)
- `*italic*` → italic (when the asterisks are NOT between word chars — `a*b*c` stays literal)
- `_italic_` → italic (same word-boundary rule as `*italic*` — `var_name` stays an identifier)
- `` `inline code` `` → monospace inline code
- ` ```language\n...code...\n``` ` → fenced code block; the optional language tag rides through (Telegram displays it but does no syntax highlighting)
- `[label](url)` → clickable hyperlink
- `~~strike~~` → strikethrough
- `||spoiler||` → spoiler (tap to reveal)

Empty markers (`****`, ` `` `, `~~~~`, `||||`) are NOT emitted as zero-width entities; they fall through as escaped literals. Telegram rejects empty entities, and the adapter's safety pass catches this for you.

## What the adapter does NOT render

Telegram's MarkdownV2 has no native rendering for any of these. They fall through as escaped literal characters — visible in the message, but not formatted:

- `# Heading`, `## Heading 2`, etc. — appear as `\# Heading` / `\## Heading 2` (the `#` shows but it's not a heading)
- `- item` / `* item` / `1. item` (bulleted or numbered lists) — the markers escape to `\-` / `\*` / `1\.` and the message stays a plain paragraph with line breaks; Telegram users see the dash or number, not a styled list
- `| col | col |\n|---|---|\n` (Markdown tables) — every `|` and `-` escapes; the result is illegible. Don't send tables. Send a fenced code block with aligned columns instead.
- `> quote` — the `>` escapes to `\>`; Telegram does have a native blockquote syntax but the agent's common-Markdown writer has no way to opt into it through this adapter today
- HTML tags (`<b>`, `<i>`, `<a>`) — the adapter does NOT use HTML mode; tag chars escape and the literal `<b>foo</b>` shows up

When you need any of these effects, **rewrite the message** to use what Telegram does support (bold for emphasis instead of headings; bullet points written as separate lines with bold leading words instead of `-` markers; aligned-column code fences instead of tables).

## Punctuation rules you can stop worrying about

You do NOT need to manually escape any of `_ * [ ] ( ) ~ \` > # + - = | { } . !` in your draft. The adapter handles it.

- Periods, exclamation points, hyphens, plus signs in prose — type them naturally; the adapter escapes them.
- Snake_case identifiers (`my_var_name`, `foo__bar__baz`) — type them naturally; the word-boundary guards keep them from italicizing.
- Math/code asterisks in prose (`a*b*c`, `2 * 3 = 6`) — same; the word-boundary guards keep them literal.
- URLs containing `_`, `.`, `-`, `~` — they pass through fine inside `[label](url)`.

URLs containing **unescaped parentheses** (Wikipedia-style `Foo_(bar)`) intentionally fall back to escaped literal text rather than render as a link — the adapter cannot disambiguate the closing `)` from a content paren. If you need to link such a URL, percent-encode the parens in the URL (`%28`, `%29`) before putting it in the link.

## Inbound attachments

Inbound Telegram messages with photos or documents show a ref-free attachment token in the text: `[Telegram attachment #N: <kind> <metadata>]`, for example `[Telegram attachment #1: photo 1280x960]` or `[Telegram attachment #1: file application/pdf name=spec.pdf]`.

- To download the attachment, call `channel_fetch_attachment` with `attachment_id: N`.
- To view an image, call `look_at_channel_attachment` with `attachment_id: N`.
- If no attachment token appears in the inbound, no attachment was sent. Do not invent attachment ids — the tool will reject ids that do not appear in the current turn.

## When the user says "your formatting looks broken"

Three classes of failure to triage in this order:

1. **Literal `**asterisks**` in the rendered message.** Means the adapter was bypassed (someone shipped a regression that flipped `parse_mode` off). Check `src/channels/adapters/telegram-bot.ts` — `sendMessage` MUST include `{ parse_mode: 'MarkdownV2' }` and the text must come from `toTelegramMarkdownV2(...)`. The mutation-guard test in `telegram-bot-outbound.test.ts` exists exactly to catch this.
2. **Visible backslashes (e.g. `v1\.2\.3`).** Means the user is on a Telegram client too old to honor MarkdownV2 entity-rendering, OR the message was forwarded to a context that doesn't (rare). Nothing the adapter can do — the wire format is correct.
3. **Telegram error: `Bad Request: can't parse entities`.** Means the formatter emitted invalid MarkdownV2 — either an entity-rule edge case the formatter mishandled, or the agent wrote something pathological (e.g. a literal MarkdownV2-escaped fragment by hand). File a bug against the formatter with the exact input string; do not work around it by sending plain text (that loses formatting for everyone).

## File pointers

- `src/channels/adapters/telegram-bot.ts` — adapter; `createOutboundCallback` is where rendering happens.
- `src/channels/adapters/telegram-bot-format.ts` — the formatter; pure, no dependencies, fully tested.
- `src/channels/adapters/telegram-bot-format.test.ts` — every formatter rule above is mutation-guarded by a named test here.
- `src/channels/adapters/telegram-bot-outbound.test.ts` — the integration mutation guard that pins `parse_mode: 'MarkdownV2'`.
