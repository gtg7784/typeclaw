---
name: typeclaw-channel-kakaotalk
description: Use this skill BEFORE every `channel_reply` or `channel_send` call whose adapter is `kakaotalk`, AND before calling `channel_fetch_attachment` against a KakaoTalk URL. KakaoTalk renders messages as plain text — `**bold**`, `## headings`, `| tables |`, fenced code blocks, and other markdown all appear literally. There is no `@mention` syntax, no message threads, no replies-with-quote, and no outbound file attachments or stickers. Inbound photos / files / video / audio CAN be downloaded via `channel_fetch_attachment` (the placeholder text includes the URL); inbound stickers are metadata-only and cannot be fetched. URLs expire ~3 days after the message arrives. Read this skill before composing or fetching anything on KakaoTalk.
---

# typeclaw-channel-kakaotalk

You are speaking through the `kakaotalk` channel adapter. The adapter wraps `agent-messenger`'s KakaoTalkClient/KakaoTalkListener, which speaks KakaoTalk's LOCO push protocol as a registered tablet sub-device of a real user account.

This means **you are messaging as a person, not as a bot.** Other participants see your typeclaw account's name and profile photo. Match their tone — the people you're talking with assume they're talking to a human.

## What KakaoTalk does NOT support

If you produce any of the following, KakaoTalk will render it literally and the recipient will see the raw markup:

- **Bold / italic / strikethrough** — `**bold**` shows as `**bold**`. Drop the asterisks; emphasize with word choice or capitalization (sparingly).
- **Headings** — `# H1`, `## H2`, `### H3` all render as raw `#` characters.
- **Tables** — pipe-delimited tables become a wall of `|` characters. Use bullet lists or short prose paragraphs instead.
- **Code fences** — ``` blocks render as raw backticks. For short snippets, paste the code inline. For long snippets, summarize and offer to send it via another channel.
- **Inline code** — `` `foo` `` renders as `` `foo` ``. Just write `foo`.
- **Links with display text** — `[label](url)` becomes the literal string. Send the bare URL on its own; the KakaoTalk client will auto-link it.
- **Mentions** — there is no `@user` syntax that the protocol surfaces. Address people by name in the message body.
- **Threads / replies-with-quote** — every message is a top-level chat post. There is no per-message reply UI.
- **Outbound attachments / stickers** — agent-messenger's KakaoTalk SDK exposes no upload API. The adapter is outbound text-only. If the user asks you to send a file or sticker, say so and offer an alternative (paste a link, summarize the file, ship it via another channel).

The adapter rejects outbound attachments via `ok: false` rather than partially sending the text — the agent contract is "ok=true means the whole request succeeded", so a silent drop would let you confidently report "I sent your file" when the file never arrived.

## What KakaoTalk DOES support

- Plain UTF-8 text. Emoji are fine.
- URLs auto-linkify in the client. Send them bare — `https://example.com/foo`, no markdown wrapping.
- Newlines render as line breaks. You can use `\n\n` to space paragraphs.

## Inbound attachments and stickers

Even though you cannot SEND attachments or stickers, you DO receive them. The adapter surfaces incoming non-text content by appending a `[KakaoTalk message with ...]` placeholder to the inbound text (same convention as Slack/Discord/Telegram). Examples of what you'll see:

- A photo (with no caption): `[KakaoTalk message with photo 1320x2868 (image/jpeg) https://talk.kakaocdn.net/...]`
- A photo with a caption: `look at this\n[KakaoTalk message with photo 1320x2868 (image/jpeg) https://...]`
- A file: `[KakaoTalk message with file spec.pdf (application/pdf) size=12345 https://...]`
- A video / audio (with a usable URL): `[KakaoTalk message with video (keys=[dur,url]) https://talk.kakaocdn.net/...]`. The SDK leaves video / audio / multiphoto payloads opaque, so we list the keys that were present alongside the URL when one exists; when no URL is present the placeholder is just `[KakaoTalk message with video keys=[...]]` and there is nothing for you to fetch.
- A sticker / emoticon: `[KakaoTalk message with sticker (sticker) pack=4412724 path=4412724.emot_001.webp]`
- An animated sticker: `[KakaoTalk message with sticker (sticker_ani) pack=... path=...]`

### Fetching attachment bytes

For photos, files, and any video / audio / multiphoto whose placeholder includes a `https://...kakaocdn.net/...` URL, call `channel_fetch_attachment` with that URL as the `ref` to download the bytes. The adapter validates the host (only `*.kakaocdn.net` is accepted — you cannot use this tool as a generic web fetcher) and returns the raw buffer plus mimetype.

Use this when you actually need to look at the content — e.g. the user sends a screenshot and asks "what's in this?". The download lands in your inbox directory and you can pass it to a vision-capable inspection tool or read it directly depending on the file type.

**Expiry caveat**: KakaoCDN URLs are pre-signed with an `expires=` timestamp baked into the query string — empirically ~3 days after the message arrived. Fetch promptly. If the URL has expired you will get a `403` error with the hint _"likely an expired pre-signed URL; ask the sender to re-share"_ — relay that to the user verbatim rather than guessing the cause.

**Stickers cannot be fetched** as bytes through this tool. The sticker placeholder carries `pack=` and `path=` identifiers (KakaoTalk sticker pack metadata), not a downloadable URL. Treat stickers as descriptive metadata only — acknowledge them ("cute sticker") without trying to "see" them.

If the inbound text is JUST a sticker (no accompanying text), the agent still gets a routed event — stickers count as engagement under `reply` and `dm` triggers (group chats with only sticker activity will not trigger `mention` because aliases require text matching).

## Message length & cadence

KakaoTalk is mobile-first. The reading surface is small and the user is on their phone. Keep messages **short and conversational**, not essay-length. If you have a long answer:

1. Lead with a one-sentence summary.
2. Optional: 2–4 short bullet-style lines (use `-` or `•` as line prefixes — the client renders them as text, not lists, but the visual rhythm still helps).
3. Stop. If the user wants more, they will ask.

Splitting one logical answer across multiple messages is fine and often more natural than one wall of text.

## Engagement model

The adapter exposes three engagement triggers via `channels.kakaotalk.engagement.trigger` in `typeclaw.json`:

- `dm` — every message in a 1:1 chat. Default-on.
- `reply` — every message in a chat where you sent the previous message. Default-on.
- `mention` — KakaoTalk has no mention syntax in the protocol. The adapter reads this trigger as "respond when an alias from `alias[]` in `typeclaw.json` appears in the text". Without configured aliases, this trigger never fires.

Stickiness behaves the same as Slack/Discord: once you've engaged in a chat, follow-up messages within `engagement.stickiness.perReply.window` ms will route to you regardless of trigger.

If you find yourself NOT receiving messages you expect to, the most likely cause is the `allow` list. KakaoTalk uses a different grammar from Slack/Discord:

- `kakao:*` — every chat the account can see (use sparingly: this is every group and DM you are a member of)
- `kakao:dm/*` — every 1:1 chat
- `kakao:group/*` — every multi-person group chat
- `kakao:open/*` — every open chat
- `kakao:<chat-id>` — a specific chat by numeric chat_id

The init wizard's default is `kakao:dm/*` because group chats with personal accounts are sensitive — every member sees every reply. Only broaden the allow list when the user explicitly asks.

## Mark read on every inbound

The adapter sends a LOCO `NOTIREAD` ack to KakaoTalk for every inbound message event it observes. The sender's unread "1" (노란숫자) clears in their client as soon as the agent's container receives the bytes. This is always-on — there is no config flag to turn it off short of editing the source. (An earlier `channels.kakaotalk.autoMarkRead` opt-in field was removed; existing configs still parse but the field is ignored.)

Things to know about this behavior:

- Auto-acking every received message is a distinct behavioral fingerprint compared to a human. A human reads messages when they open the chat; this adapter acks every received message instantly, even ones you never reply to. KakaoTalk's abuse detection may flag accounts that ack rapidly and unconditionally. **Run the kakaotalk adapter only on dedicated agent accounts you can afford to lose.**
- Dropped messages are still acked. If classify drops the message (your own self-sent loopback, empty text, sender not in `allow`), the unread "1" still clears — the agent has observed the bytes, so the read indicator should match.
- Open chats (오픈채팅) are skipped: the LOCO `NOTIREAD` packet needs a `linkId` for open chats and the adapter doesn't surface it yet. Unread counters in open chats will not decrement.
- The phone's home-screen OS unread badge may lag until the phone client foregrounds; the in-chat counter and other participants' indicators update immediately. KakaoTalk client quirk, not a typeclaw bug.

If a markRead call fails (network blip, non-success status from the server, container shutdown), it is logged at warn level (`[kakaotalk] mark-read failed: ...`) and silently moves on — message delivery is never blocked by an ack failure.

## Self-loop guard

The adapter drops every inbound where `event.author_id` equals the logged-in account's `user_id`. Two typeclaw agents talking to each other through KakaoTalk would otherwise loop indefinitely (KakaoTalk has no bot-flag, so neither side can detect the other is automated). Do not try to defeat this guard.

## When you cannot answer in KakaoTalk

If the user asks you to do something the adapter cannot do (send a file, render markdown, post in a thread), say so plainly:

> "I can't attach files through this chat. Want me to drop the file in [other channel] instead?"

Better than silently dropping the attachment and pretending you sent it.
