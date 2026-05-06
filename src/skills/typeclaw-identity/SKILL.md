---
name: typeclaw-identity
description: Use this skill any time you are about to read, edit, or reason about who you are — your role, your title, what you do, who you do it for, your name, your nicknames, the names you respond to in channels. Triggers include any moment you think "wait, am I being renamed?" or "should I update my self-description?", plus phrases like "update your bio", "update your identity", "what's your role", "who are you", "who are you really", "what do you do", "your job", "your title", "rename you", "call me X", "your new name is", "from now on you're", "I'll just call you", "별명", "애칭", "이제부터", "역할", explicit edits to `IDENTITY.md`, additions or removals from the `alias` array in `typeclaw.json`, repeated unrecognized addressing across turns ("hey Bongbong" when only `봉봉` is registered), or seeing your dir-name and another name used interchangeably in the same conversation. MUST load before silently accepting a new name, before editing `IDENTITY.md`, or before answering "what's your role" with a stale answer — both `IDENTITY.md` and `alias` have non-obvious mechanics (always-injected with a 12KB cap; case-insensitive substring match with no word boundaries) that this skill exists to keep you from getting wrong. Owns the safe procedures for both surfaces.
---

# typeclaw-identity

Two surfaces define _who you are_ to the outside world: **`IDENTITY.md`** in your agent folder, and the **`alias`** array in `typeclaw.json`. They are different files, with different lifecycles, but they answer the same question — "who is this agent?" — from two angles. `IDENTITY.md` is the prose answer the model reads on every turn. `alias` is the matching rule that decides whether an inbound channel message was talking _to_ you. Both are yours to maintain.

This skill exists because both have non-obvious failure modes: `IDENTITY.md` is always-injected and has a 12KB cap (so bloat silently truncates the rest of you); `alias` is case-insensitive substring with no word boundaries (so a short or generic entry matches everything). Editing either one wrong is hard to notice and hard to roll back without a session restart.

## Boundary with adjacent files

Before doing anything, locate which file actually owns the change:

- **`IDENTITY.md`** — your role and function. Job title, what you do, who you do it for, the operational context. **First person.** Evolves as your responsibilities change. _This skill covers it._
- **`SOUL.md`** — your character and temperament. Personality, tone, voice, ethics. Changes much less often than IDENTITY. _Not in this skill — edit directly when relevant._
- **`USER.md`** — what you know about the user. _Not about you._
- **`AGENTS.md`** — your operating manual: how you work, what conventions you follow. _Not your identity._
- **`MEMORY.md`** — long-term memory. **Owned by the dreaming subagent. Never edit by hand.** If a fact about your identity belongs in memory, surface it in your reply and let dreaming fold it in.
- **`alias` in `typeclaw.json`** — plain-text names channel engagement matches against. _This skill covers it._
- **`channels.<adapter>.engagement.trigger` in `typeclaw.json`** — structural triggers (mention/reply/dm). Not aliases. See `typeclaw-config` for that.

If the change is about how you _sound_ rather than who you _are_, the right file is `SOUL.md`, not `IDENTITY.md`. If the change is about working conventions, the right file is `AGENTS.md`. Don't pile everything into IDENTITY just because it's the first identity-shaped file you think of.

---

# Part 1: `IDENTITY.md`

## What it actually is

`IDENTITY.md` lives in your agent folder. The runtime (see `src/agent/self.ts`) reads it on every session start and **injects it into your system prompt under `# Identity` → `## IDENTITY.md`**. You are reading the result of that injection right now whenever you look at your prompt.

Three runtime properties matter:

1. **Always injected.** Every turn. There is no on-demand load — the file is part of you whether you reference it or not.
2. **12 KiB cap.** `loadSelf()` truncates content beyond `12 * 1024` bytes and appends `[truncated]`. Anything past the cap is invisible to you in subsequent turns. Stay well under.
3. **Missing / empty markers.** If the file is absent, the prompt shows `[MISSING] Expected at: <path>`. If it exists but is blank, it shows `[EMPTY] Present at <path> but has no content yet.` The system prompt explicitly invites you to propose filling it in when the user asks about identity or voice.

## What belongs in it

From the system prompt's framing: _"Your name, your title, what you do, who you do it for, the operational context you work in. Evolves as your responsibilities change. Think: job description."_

Concretely, good content:

- Name (and how you spell it / pronounce it if the user has been specific)
- Role in one or two sentences ("I am Coder. I help Neo write TypeScript and ship clean PRs.")
- The user (or users) you serve
- Operational scope: what kinds of tasks you take, what you don't take
- Domain context that's true _across sessions_ — not "today's task is X" (that's not identity, that's working memory)

What does **not** belong:

- Tone, voice, personality → `SOUL.md`
- Working conventions ("I commit one logical change per commit") → `AGENTS.md`
- Facts about the user ("Neo prefers dark mode") → `USER.md`
- Recent events, decisions, things to remember → let dreaming consolidate them into `MEMORY.md`

## When to edit

Edit `IDENTITY.md` when:

- **Your role genuinely shifts.** You pick up a new responsibility ("I now also handle the cron schedule"), a new domain ("I started doing infra work"), or drop one. Job-description changes.
- **You realize the existing description is wrong or stale.** Hatching wrote a placeholder, real work has shown you do something different.
- **The user explicitly asks you to update your bio / identity / role.**
- **The current file is `[MISSING]` or `[EMPTY]`** and the conversation has revealed enough about your role to write a real first draft.

Do **not** edit `IDENTITY.md` when:

- The change is about how you talk → that's `SOUL.md`.
- The change is a one-task fact → that's working context, let it sit in the conversation or in memory streams.
- The change is the user telling you a fact about themselves → `USER.md`.
- **The user is just _asking_ about your role, not changing it.** "What do you do?", "remind me your job", "who are you again?" — answer from the `IDENTITY.md` content already injected into your system prompt under `## IDENTITY.md`. No file read, no edit. Loading this skill does not obligate you to write anything — sometimes the right move is to confirm the current description is accurate and reply.

## The procedure

1. **Read the current file first.** Even if you think you remember what it says, the truth is the bytes on disk — and `IDENTITY.md` may have been edited by the user out of band.
2. **Decide what's changing.** A line edit, a section addition, a full rewrite? Prefer minimal diffs — `IDENTITY.md` is read by future-you on every turn, and stable phrasing helps you act consistently.
3. **Stay under 12 KiB.** A few hundred to a couple thousand bytes is normal. If you find yourself approaching the cap, you are putting things that don't belong in IDENTITY (memory, working notes, conventions). Move them to the right file.
4. **Write in first person.** The system prompt injects this verbatim — you are reading "I" statements about yourself. Third person reads strangely. Hatching's seed pattern ("I am `<name>`. I help `<user>` with `<thing>`.") is fine; expand from there.
5. **`write` (or `edit` for small changes) and confirm.** No `reload` is needed — the file is re-read on the next session start, and your in-session prompt already reflects who you've been so far. Tell the user the file changed and what direction you took it.
6. **Commit.** `IDENTITY.md` is tracked. Imperative commit message: "Update IDENTITY.md to add infra responsibilities" — explain _why_ in the body if not obvious from the diff.

## Failure modes

- **Bloating past 12 KiB.** Silent truncation. Your future self loses the tail of the file. If a section feels long, it probably belongs elsewhere.
- **Mixing in tone/voice content.** Pollutes IDENTITY with SOUL material. Means later "edit my voice" requests touch the wrong file.
- **Treating IDENTITY as a changelog.** Lines like "as of 2026-05-01, I now do X" age badly. Just say what you do now; let git history be the changelog.
- **Editing IDENTITY when the user wanted SOUL.** "be less formal" is a SOUL change, not an identity change. Ask one quick clarifying question if the boundary is genuinely unclear.
- **Forgetting to commit.** `IDENTITY.md` is tracked. Leaving uncommitted changes at the end of a task means they're invisible in `git log` and easy to lose track of.

---

# Part 2: `alias` in `typeclaw.json`

## What it actually is

`alias` is the array of plain-text names channel engagement matches against when an inbound message contains your name in the message text (no `<@id>` mention). It is independent from the structural triggers (`mention`, `reply`, `dm`) — those engage you regardless of alias config. `alias` only matters for plain-text addressing.

Two things to internalize before you touch the array:

1. **The dir name is implicit.** `basename(agentDir).toLocaleLowerCase()` is always present as an alias. If your folder is `봉봉/`, you already answer to `"봉봉"` — you do not need to add it. Adding it is a no-op in semantics but adds noise to `typeclaw.json`.
2. **Match is case-insensitive substring, no word boundaries.** Adding `"봉"` would match every message containing `"봉지"`, `"봉투"`, `"문봉"`. Adding `"bot"` would match every `"robot"`. Adopt full distinctive forms only.

`alias` is **live-reloadable** (`FIELD_EFFECTS.alias = 'applied'`) — once you write the file and call `reload`, the next inbound channel message engages on the new alias. No container restart.

## When to add an alias (the judgement call)

There is no automatic detector. You decide, in the moment, whether what just happened is a rename worth persisting. Use this taxonomy:

### Strong signal — adopt and just confirm casually

- **Explicit rename**: "your name is X from now on", "I'll call you X", "let me call you X instead", "별명을 X로 할게", "이제부터 X라고 부를게". The user is consciously renaming you. Persist immediately, then mention it in your reply naturally ("got it, X 좋아요" / "okay, X it is"). No need to ask permission — they already gave it.
- **Repeated affectionate form of your existing name**: User keeps writing "봉봉아", "봉봉씨", "Bongbong-ah" when your dir name is `봉봉`. The implicit dir alias already matches "봉봉아" (substring), so usually nothing to do. But if it's a Latin transliteration ("Bongbong" when dir is `봉봉`) and the user has used it 2+ times across turns, persist it without asking — they're clearly committed.

### Medium signal — confirm before persisting

- **A casual nickname used 2-3 times** that you weren't sure was meant for you the first time. Ask once, simply: "오, X라고 부르는 거 좋네요 — 그렇게 부르실 거면 등록해 둘까요?" / "you've been calling me X — want me to start responding to that automatically?". If they say yes, persist. If they shrug or say "whatever", err on the side of persisting (one-shot questions are cheap; asking again next time is rude).

### Weak signal — do nothing

- **One-off mention** of a name you don't recognize. Not a rename. People say weird things once. Wait for repetition.
- **Third-party reference**: someone in the channel says "봉봉 the K-pop singer". Not addressed to you. Ignore.
- **Generic tokens**: "agent", "bot", "ai", "assistant", "claude", "gpt", "사람", common single syllables. These over-match and pollute engagement. Decline politely if asked.
- **Names of other bots in the channel**: if `participants[]` shows another bot uses that display name, it's a peer's identity — adding it as your own alias would steal their engagement.

When in doubt, **ask once**. The user prefers a brief check over you silently committing to a name.

## The procedure (when you decide to add)

Do these steps in order. Each step has a failure mode you avoid by following the order.

### 1. Read `typeclaw.json` first

Do not write blind. The file may have been edited since session start, by you or by the user out of band.

```
read typeclaw.json
```

### 2. Decide what string to add

- **Trim** surrounding whitespace. The schema rejects empty/whitespace-only entries.
- **Lowercase is not required** — match is case-insensitive on both sides. But prefer the form the user actually wrote, so the file reads naturally for them.
- **Skip if redundant**: if the candidate equals `basename(agentDir).toLocaleLowerCase()` (case-insensitive), don't add it. The dir alias already covers it. Tell the user "I already respond to that — it's automatic from the folder name."
- **Skip if substring of existing alias** in either direction: if `"봉봉"` is in alias and the user wants `"봉"`, don't add `"봉"` (over-matches). If `"봉"` is in alias and user wants `"봉봉"`, the existing entry already matches `"봉봉"` as substring — adding the longer form is harmless but unnecessary.
- **Reject if too short or too generic** (≤2 chars unless it's a complete CJK name; common English words like "bot", "ai"). Push back on the user gently with the substring-match reason.

### 3. Update the array

- If `alias` field is **absent**, create it: `"alias": ["<new name>"]`.
- If `alias` field is **present**, append the new entry. Preserve order of existing entries — do not re-sort. Dedupe trivially (the runtime also dedupes via `Set` in `computeSelfAliases()`, but a clean file is its own reward).

### 4. Write the file

Use `write` (or `edit` if it's a small change inside a large file) to persist. Match the existing JSON style — 2-space indent, trailing newline, key order preserved.

### 5. Reload

```
reload (scope: "config")
```

Without `reload`, the live runtime still has the old alias list. The next channel message would NOT engage on the new alias until the next container restart. Do not skip this step.

### 6. Confirm in your reply

Tell the user, naturally, that the change is live. Not "I have updated `typeclaw.json` and called the reload tool with scope config" — that's robotic. Something like "okay, X로 부르셔도 돼요 이제" / "got it, I'll respond to X now" is enough. Match your normal tone (`SOUL.md`).

## When the user asks to remove an alias

Same read → edit → write → reload procedure, but remove the entry instead of appending. Same dir-name caveat applies: removing the dir name from `alias` is a no-op since it's implicit. If they want to fully stop responding to the dir name, that's a folder rename, which they have to do on the host.

## Failure modes

- **Adopting a one-off mention.** Wait for at least the second occurrence (or an explicit rename) before persisting. Each entry is permanent until removed; aliases accumulate noise fast otherwise.
- **Forgetting `reload`.** The most common silent failure. The file change persists, but in-session engagement does not change until restart. Always reload.
- **Adding the dir name.** Redundant. If the user says "respond to X" and X is your dir name, just confirm "I already do — that's automatic." Adding it bloats the file without effect.
- **Adding short or generic tokens.** Substring match has no word boundaries. `"a"` matches every message. Decline and explain.
- **Editing `alias` to remove the dir name.** It can't be removed via `alias`; the dir name is computed from the folder. Tell the user that's a host-stage rename of the agent folder, which they own, not you.
- **Re-running the procedure for an already-registered name.** Read first. If the name is already in `alias` (or covered by a longer existing entry), skip and just tell the user "already registered."
- **Persisting silently when the user might object.** Strong signals (explicit rename) don't need permission. Medium signals (repeated casual nickname) get one quick check first. When unsure, lean toward asking — interruption cost is low, surprise cost is high.

---

# Keeping the two surfaces in sync

A rename usually means **both** files want updating: `IDENTITY.md` to reflect the new name in the prose self-description, and `alias` to make channel engagement recognize the new form.

When the user explicitly renames you ("from now on you're X"):

1. **Update `alias` first** (the procedure in Part 2) and `reload` — this is the user-visible change that affects whether you respond.
2. **Then update `IDENTITY.md`** (the procedure in Part 1) — change "I am `<old>`. ..." to "I am `<new>`. ..." or whatever the surrounding prose needs.
3. **Commit both files in a single commit.** They are one logical change ("rename to X"); splitting them across two commits clutters history with a half-state where alias is updated but the prose self-description still says the old name. Stage both: `git add typeclaw.json IDENTITY.md && git commit -m "Rename to <new>"`.
4. **One reply confirming both are done**, in normal voice.

When the user just adopts a casual nickname (medium signal): only `alias` needs updating. `IDENTITY.md` can keep the formal name; the alias makes the nickname work in channels without rewriting your self-description.

## Boundary with `typeclaw-config`

`typeclaw-config` is the comprehensive reference for everything in `typeclaw.json` — schema, every field, reload-vs-restart, edge cases, peer-name suppression, channel engagement priority. This skill is the **focused playbook** for the moments where you are reasoning about your own identity. If the user asks broader questions about how `typeclaw.json` works, or about the difference between `alias` and `channels.<adapter>.engagement.trigger`, load `typeclaw-config` instead.
