---
name: typeclaw-channel-kakaotalk
description: Use this skill BEFORE every `channel_reply` or `channel_send` call whose adapter is `kakaotalk`. KakaoTalk renders messages as plain text — `**bold**`, `## headings`, `| tables |`, fenced code blocks, and other markdown all appear literally. There is no `@mention` syntax, no message threads, no replies-with-quote, and no file attachments. Read it before composing anything for KakaoTalk so you don't dump markdown into a chat window.
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
- **Attachments** — the adapter is text-only. If the user asks you to send a file, say so and offer an alternative (paste a link, summarize the file, ship it via another channel).

The adapter logs a warning the first time you try to send attachments and then drops them. The user-visible result is "your message arrived without the file."

## What KakaoTalk DOES support

- Plain UTF-8 text. Emoji are fine.
- URLs auto-linkify in the client. Send them bare — `https://example.com/foo`, no markdown wrapping.
- Newlines render as line breaks. You can use `\n\n` to space paragraphs.

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

## Auto mark read (opt-in)

If `channels.kakaotalk.autoMarkRead` is `true` in `typeclaw.json`, the adapter sends a LOCO `NOTIREAD` ack to KakaoTalk after every inbound message it delivers to the router. The sender's unread "1" (노란숫자) clears in their client as soon as you receive it. Off by default.

Trade-off you should know about before enabling it:

- Auto-acking every received message is a distinct behavioral fingerprint compared to a human. A human reads messages when they open the chat; this setting acks every received message instantly, even ones you never reply to. KakaoTalk's abuse detection may flag accounts that ack rapidly and unconditionally. Enable only on dedicated agent accounts you can afford to lose.
- Dropped messages (your own self-sent, empty text, sender not in `allow`) are not acked — only routed messages.
- Open chats (오픈채팅) are skipped: the LOCO `NOTIREAD` packet needs a `linkId` for open chats and the adapter doesn't surface it yet. Unread counters in open chats will not decrement even with `autoMarkRead: true`.
- The phone's home-screen OS unread badge may lag until the phone client foregrounds; the in-chat counter and other participants' indicators update immediately. KakaoTalk client quirk, not a typeclaw bug.

If a markRead call fails (network blip, non-success status from the server, container shutdown), it is logged at warn level and silently moves on — message delivery is never blocked by an ack failure.

## Self-loop guard

The adapter drops every inbound where `event.author_id` equals the logged-in account's `user_id`. Two typeclaw agents talking to each other through KakaoTalk would otherwise loop indefinitely (KakaoTalk has no bot-flag, so neither side can detect the other is automated). Do not try to defeat this guard.

## When you cannot answer in KakaoTalk

If the user asks you to do something the adapter cannot do (send a file, render markdown, post in a thread), say so plainly:

> "I can't attach files through this chat. Want me to drop the file in [other channel] instead?"

Better than silently dropping the attachment and pretending you sent it.
