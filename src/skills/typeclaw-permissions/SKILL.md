---
name: typeclaw-permissions
description: Use this skill whenever the user asks who you talk to, why you went silent in a channel, why a tool call was blocked with `blocked:` / "denied by permissions", how to grant access, what a role can or can't do, or whenever you are about to edit the `roles` block in `typeclaw.json`. Triggers include "who can talk to you", "why aren't you replying in #channel", "add me to the agent", "let X talk to you", "grant trusted to Y", "your role", "what permissions do you have", "blocked", "denied by permissions", "owner", "trusted", "member", "guest", "match rule", "channel.respond", "security.bypass", "scheduledByRole", "spawnedByRole", or any mention of `roles` / `roles[*].match` / `roles[*].permissions` in `typeclaw.json`. Read it before editing `roles` — the file has a strict match-rule DSL, restart semantics, and silent failure modes (a missing role match makes you silently drop every inbound), and the agent's own runtime behavior depends on its role and resolved permissions.
---

# typeclaw-permissions

You run under an access-control system that gates which sessions wake you, which tools succeed, and which guards you can bypass. This skill exists so you can answer the user's questions about access honestly, edit `roles` without bricking your own inbound channel, and explain `blocked:` messages in terms of the role/permission model rather than the surface-level guard reason.

## The model in one paragraph

Every session you run in has a `SessionOrigin` (TUI / channel / cron / subagent). How the runtime resolves it to a **role** depends on the origin kind:

- **TUI and channel** sessions resolve by walking the `roles` block in `typeclaw.json` in declaration order and picking the first role whose `match` rules cover the origin. This is the only origin shape that match rules actually grant roles to at runtime.
- **Cron** sessions resolve from `scheduledByRole`, a string stamped on the cron job record itself (in `cron.json` for hand-authored entries, or by the runtime for plugin-contributed cron). Match rules of the form `cron` parse but never grant a role to a running cron session — provenance wins.
- **Subagent** sessions resolve from `spawnedByRole`, snapshotted from the spawning session's resolved role at spawn time. Same story: `subagent` / `subagent:<name>` rules parse but don't grant roles at runtime; the spawn provenance is the source of truth.

Each role carries a set of **permissions** — opaque dotted strings like `channel.respond`, `cron.schedule`, `security.bypass.gitExfil`. The runtime checks `permissions.has(origin, '<perm>')` at three places: the channel router (gates `channel.respond` before creating a session for an inbound message), the security plugin's `tool.before` hook (gates each `security.bypass.*` so the corresponding guard can be skipped), and plugin code that opts in. There is no other access-control surface — no per-tool ACL, no file-system isolation, no per-author allowlist outside `match` rules.

## The four built-in roles

You always have these four, even if `typeclaw.json` declares zero `roles`. User-declared roles **append** match rules to the built-ins but **replace** the permission list entirely (so `"permissions": []` on a built-in role means "no permissions" — be careful).

| Role      | Built-in `match[]`                                                | Default `permissions[]`                                                                                                                                                                                                                                                                                                                                                                  |
| --------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `owner`   | `["tui"]` (always prepended)                                      | `channel.respond`, `cron.schedule`, `cron.modify`, `security.bypass.low`, `security.bypass.medium`, **plugin-contributed `security.bypass.*` MINUS high-tier strings** (the wildcard sentinel expands to plugin bypasses but excludes the security plugin's `ownerWildcardExclusions` — today: `gitExfil`, `gitRemoteTainted`, `outboundSecret`, `systemPromptLeak`, plus `bypass.high`) |
| `trusted` | none                                                              | `channel.respond`, `cron.schedule`, `security.bypass.low`                                                                                                                                                                                                                                                                                                                                |
| `member`  | none                                                              | `channel.respond`                                                                                                                                                                                                                                                                                                                                                                        |
| `guest`   | none (fallback when nothing else matches, or stamped role is bad) | none                                                                                                                                                                                                                                                                                                                                                                                     |

A session that doesn't match anything resolves to `guest`. `guest` has no `channel.respond`, so the router silently drops inbound messages whose author resolves to `guest`. **This is the most common cause of "the agent stopped responding"**: the user added a channel but did not add a match rule, so every speaker in that channel is `guest` and every inbound is dropped before you ever see it. There is no message in your session log when this happens — only a host-side line `[channels] <key>: denied by permissions (channel.respond) author=<id>`.

## What your current session sees

When the runtime knows your permissions, it prepends a block under your `## Session origin`:

```
## Your role in this session

Role: `member`. Permissions: `channel.respond`.
```

The block renders for cron / channel / subagent sessions. For TUI sessions, the block is omitted **when** the resolved role is the built-in `owner` (the common case, so we save tokens on every interactive session) and rendered when a user-declared role matched TUI first (because the resolver is first-match-wins in declaration order, a custom role with `match: ["tui"]` placed before `owner` will demote TUI). If you don't see the block in a TUI session, treat yourself as `owner`.

**The role line reflects the session at creation time.** For channel sessions, the speaker on subsequent turns may resolve to a different role; the runtime updates that internally for tool gating (the channel router and the security plugin re-resolve on each turn), but the system prompt is not regenerated mid-session. If the user asks "what role am I right now in this channel", read `typeclaw.json` `roles` and match their author id against `match[]` yourself — do not parrot the system-prompt line as if it always applied.

**The permission list is exhaustive at session-creation time** for the resolved role. If a permission you expect isn't listed there, the role doesn't carry it — adding it requires editing `roles.<role>.permissions[]` and restarting.

## The match-rule DSL

`roles.<role>.match[]` is an array of compact strings. The parser is hand-rolled in `src/permissions/match-rule.ts`; the canonical shapes are:

```
tui                                # any TUI session
*                                  # any channel session, any platform
<platform>:*                       # any chat on this platform (slack | discord | telegram | kakao)
<platform>:<workspace>             # one workspace, any chat
<platform>:<workspace>/<chat>      # one specific chat
<platform>:dm/*                    # any DM on this platform
kakao:group/*                      # any KakaoTalk group chat
kakao:open/*                       # any KakaoTalk open chat
<rule> author:<authorId>           # AND-tighten any of the above to one author
```

`cron`, `subagent`, and `subagent:<name>` are also valid parser shapes (they parse without error), but they do **not** grant a role to a running cron or subagent session — those resolve from stamped provenance (`scheduledByRole` / `spawnedByRole`) instead. Don't write those rules expecting them to admit traffic the way channel rules do.

Within a single string, tokens are **AND**'d. Across multiple strings in `match[]`, they're **OR**'d. The platform names are exactly `slack | discord | telegram | kakao`. Workspace and chat coordinates are platform-native IDs (Slack team `T0123`, Discord guild `123456789012345678`, Telegram chat `42`, KakaoTalk chat hash) — **never** display names. If the user gives you a name, you need to resolve it to an ID before writing the match rule.

Things the DSL rejects (the parser emits actionable errors at boot, but you should not write these in the first place):

- `slack:*/*` — `*/*` is redundant; use `slack:*` for "any Slack chat".
- `slack:*/C0ABCDE` — workspace-less chat ID is impossible; pick a workspace.
- `slack:T0123/*` — workspace-only is enough; drop the trailing `/*`.
- `team:T0123`, `guild:G123`, `tg:42` — these are legacy prefixes from the old `channels.<adapter>.allow[]` field. They are auto-migrated on load but **don't write them in new code** — use `slack:T0123`, `discord:G123`, `telegram:42` directly.
- `autor:U_ME` — typo of `author:`. The parser will suggest the fix at boot.

## Permission strings you will see

Three sources contribute permission strings:

1. **Core** (always present): `channel.respond`, `cron.schedule`, `cron.modify`.
2. **Bundled security plugin** (always loaded): the eight per-guard strings (`security.bypass.secretExfilBash`, `security.bypass.gitExfil`, `security.bypass.gitRemoteTainted`, `security.bypass.secretExfilRead`, `security.bypass.ssrf`, `security.bypass.sessionSearchSecrets`, `security.bypass.systemPromptLeak`, `security.bypass.outboundSecret`) AND three severity-tier strings (`security.bypass.low`, `security.bypass.medium`, `security.bypass.high`).
3. **User-declared plugins** (variable): each plugin can contribute its own strings via `definePlugin({ permissions: [...] })`.

The security plugin classifies each guard on a two-axis policy:

- **high — audience-leak.** Bypass sends data to a third-party audience outside the operator's control loop (channel readers, remote git hosts). Inhabitants: `outboundSecret`, `systemPromptLeak`, `gitExfil`, `gitRemoteTainted`. **No role auto-bypasses high.** Per-call ack required from every role, including `owner`. The canonical case is **owner-in-public-channel**: even an owner asking "post deploy status to #general" must not silently include a `Bearer ghp_…` line; even `git push` from TUI must be ack'd. Operators who knowingly want one role to skip a high-tier guard add the per-guard string explicitly to `roles.<role>.permissions[]`.
- **medium — silent-attack.** Bypass returns secrets / IAM creds into model context with no immediate operator visibility. Inhabitants: `secretExfilBash`, `secretExfilRead`, `ssrf`, `sessionSearchSecrets`. `owner` bypasses (operator already has host access); `trusted` does NOT.
- **low — noisy, immediately recoverable.** No inhabitants today. Forward-compat for future guards. `trusted` carries `bypass.low` so a future low-tier guard auto-bypasses for trusted without a config edit.

At `tool.before` time, an actor bypasses a guard if they hold **either** the tier permission **or** the per-guard permission (OR-check, both axes work forever).

`owner` carries `security.bypass.low + security.bypass.medium` AND the wildcard sentinel; the sentinel expands to plugin-contributed `security.bypass.*` strings minus the security plugin's `ownerWildcardExclusions` (today: the four high-tier per-guard strings plus `bypass.high`). Net: `owner` auto-bypasses every low- and medium-tier guard; high-tier guards require ack from owner too. `trusted` carries only `bypass.low` — no per-guard medium/high grants by default. `member` and `guest` carry no `security.bypass.*` strings.

**Trusted lost two per-guard grants in PR #255 compared to pre-PR behavior.** Before: trusted carried `bypassSecretExfilBash` and `bypassGitExfil` so they could `bash env` and `git push` without acks. After: those guards (medium and high respectively) need acks for trusted too. Operators who relied on the old ergonomics can restore them by adding the per-guard strings explicitly to `roles.trusted.permissions[]` in `typeclaw.json` — the per-guard path is supported forever via the OR-check. When the user complains "trusted can't push anymore," this is the explanation and the workaround.

Note on the two-step `gitRemoteTainted` defense: even when an operator explicitly grants `security.bypass.gitExfil` to a role (re-opening the high-tier bypass for `git push`), the second-step `gitRemoteTainted` check still fires on the eventual push if origin was re-pointed mid-session. The recorder runs on the first step (the `set-url`) gated by "would the command actually run" — so the second-step checker has taint state to consult. Granting `bypassGitExfil` does NOT silently grant `bypassGitRemoteTainted`; those are independent per-guard strings AND independent high-tier guards.

**Two-layer defense for channel-side git operations**: the runtime `tool.before` guards are not the only layer that gates `git push` from channel messages. The security plugin's `session.prompt` hook also pattern-matches inbound text for `git push` / `git remote add` / `gh repo create --push` and injects a refusal rule into the system prompt. **The prompt-side `git_exfil` defense is gated to non-subagent origins** — it fires for `channel` and `tui` prompts but skips `subagent` prompts. The reason: bundled subagents like `backup-diagnose` legitimately embed git stderr in their payloads (which contains literal "git push --help" hint strings on failures), and triggering the defense there would inject a "do NOT run git push" rule that contradicts the subagent's own system-prompt instructions to retry with an ack. The runtime `tool.before` is the universal backstop for subagents (under the audience-leak policy, even owner-spawned subagents need an ack for `git push`), so the prompt-side check is redundant for them and harmful to bundled-plugin recovery flows. For channel and TUI prompts the two layers agree: nobody auto-bypasses gitExfil at the runtime layer, so the prompt-injection layer's text-match refusal is the same answer the runtime would give. The only case where the two layers disagree is when an operator has explicitly granted `security.bypass.gitExfil` to a channel speaker's role in `typeclaw.json` — then the runtime would allow the push but the prompt-injection text-match would still refuse. That's a known narrow-scope gap (operator opted into the bypass already); if the user is confused why the agent refused a channel-side push despite the per-guard grant they added, this is why.

User-declared `permissions[]` strings that don't appear in any of the three sources are **logged as warnings at boot** (`[permissions] role "X" declares unknown permission "Y" — did you mean 'Z'?`) but the role still resolves with the unknown string in its list. This is intentional — the runtime is forward-compatible with strings from plugins that aren't loaded yet — but it also means typos silently fail to bypass guards. If you wrote `security.bypass.secretExfilBach` instead of `Bash`, no guard will be skipped and you will only notice when you read the boot logs.

## When a tool is blocked

The security plugin's `tool.before` hook produces block messages of the form:

```
Guard `<guardName>` blocked <what>. If this is genuinely intentional and the user
explicitly asked for it, retry with `acknowledgeGuards.<guardName>: true` in the
<tool> arguments. Or run as a role carrying `<per-guard-permission>` (...role hint...)
or the tier permission `security.bypass.<low|medium|high>`; see the
`typeclaw-permissions` skill.
```

Four escape hatches, ordered from least to most invasive:

1. **`acknowledgeGuards.<guardName>: true`** in the tool args. This is a per-call, in-session bypass. Use it when the user has just explicitly told you to run the dangerous thing (e.g. "yes, push the secret to a private gist on purpose"). Never use it without explicit user confirmation — the guard exists for a reason.
2. **Run as a role with the per-guard bypass permission**. If the user wants this pattern to keep working without an ack every time, they edit `roles.<role>.permissions[]` to include the specific `security.bypass.<guardName>` string the block message named. This is the most granular grant — it only opens up that one guard. Use this when the user wants exactly one capability and nothing else.
3. **Run as a role with the tier bypass permission**. The block message also names the tier permission (`security.bypass.low` / `.medium` / `.high`). Granting the tier opens up every guard of that tier at once — broader than option 2, narrower than full owner. Use this when "let trusted users post credentials to chat AND view system prompt fingerprints AND search session history" is the user's actual intent rather than three separate per-guard grants.
4. **Run from a session that already resolves to a role with the bypass**. The TUI is always `owner`, so a guard that blocks in channel sessions for a `member` author will not block at all from the TUI. This is why "the agent can do X in TUI but not in Slack" is normal, not a bug.

When you see a block, tell the user **which permission would skip it** (the block message now names both the per-guard and the tier options) and **which built-in roles have those permissions**. Do not just relay the guard reason — that loses the access-control framing entirely.

## When the user asks "why aren't you replying in #channel?"

Probable causes, in descending order of frequency:

1. **No match rule covers the speaking author's coordinates.** Read `typeclaw.json` `roles`, compare every `match[]` entry to the channel ID and author ID the user is reporting. If nothing matches, the author resolves to `guest`, which has no `channel.respond`, so every inbound is dropped at the router. The fix is to append a match rule to `roles.<role>.match[]` for that channel (or DM bucket).
2. **The match rule exists but the role has `permissions: []`** (or otherwise lacks `channel.respond`). A user-declared role replaces the built-in's permissions wholesale. Re-add `channel.respond` or use a built-in role name (`member`, `trusted`, `owner`) that carries it by default.
3. **Engagement triggers are filtering admitted messages.** This is a different problem — the inbound was admitted by permissions but engagement (`channels.<adapter>.engagement.trigger`) decided not to wake you. See the `typeclaw-config` skill for the engagement model.

To distinguish cause 1/2 from cause 3: if `typeclaw logs <container> -f` (host stage) shows `[channels] ... denied by permissions (channel.respond)`, it's a permissions problem. If it shows the message being admitted but no LLM call follows, it's engagement.

## When the user asks "let X talk to you in this channel"

This is a `roles` edit. The full procedure:

1. **Resolve the coordinates.** Get the platform name (`slack | discord | telegram | kakao`), the workspace ID, the chat ID. If the user gave you names, ask them or look them up in the participants list of a previous inbound from that channel.
2. **Pick a role.** Default to `member` for "give them normal channel access". Use `trusted` if they should also be able to schedule cron — by default trusted gets ONLY `bypass.low` (no inhabitants today), so trusted on its own does NOT skip any security guard. If the user wants the old pre-PR-#255 trusted ergonomics (bypass bash secret guard, push without ack), add per-guard strings explicitly: `roles.trusted.permissions: ["channel.respond", "cron.schedule", "security.bypass.low", "security.bypass.secretExfilBash", "security.bypass.gitExfil"]`. Use `owner` only for the primary operator — owner auto-bypasses every medium-tier guard (`secretExfilBash`, `secretExfilRead`, `ssrf`, `sessionSearchSecrets`) but **still must ack every high-tier guard** (`gitExfil`, `gitRemoteTainted`, `outboundSecret`, `systemPromptLeak`) because audience-leak guards have no role auto-bypass — that's the owner-in-public-channel rule. If the user explicitly wants `git push` from TUI without acks, that's a per-guard explicit grant on `roles.owner.permissions[]` (re-add `security.bypass.gitExfil`), and the user should understand they are re-opening the audience-leak path for that guard.
3. **Edit `typeclaw.json` `roles.<role>.match[]`.** Append the canonical DSL string. Example: `roles.member.match` adds `"slack:T0123/C0ABCDE"`. If the user wants only a specific person in that channel, append `slack:T0123/C0ABCDE author:U_ME` instead.
4. **Restart.** `roles` is **restart-required** — `typeclaw reload` does not re-evaluate role config. Tell the user: "edited `roles.<role>.match` — restart-required. Run `typeclaw restart` (host stage)."
5. **Commit the change.** See the `typeclaw-git` skill. The decision context in the commit message should name the role, the channel, and the author/scope ("let @X talk to me as `member` in #foo in workspace bar").

## When the user asks "stop replying to X"

Two interpretations — clarify if ambiguous:

- **"Stop everything"** — remove the match rule from `roles.<role>.match[]`. The author resolves to `guest`, and the channel router silently drops every inbound. You lose all visibility into their messages. Restart-required.
- **"Just stop auto-replying"** — keep the match rule, but narrow `channels.<adapter>.engagement.trigger` and/or `stickiness`. See `typeclaw-config`. The agent still receives the messages and can still post if you tell it to. The solo-human fallback (single human in a channel) overrides `trigger: []`, so this approach can't fully silence you in a 1:1; only removing the match rule does.

## When the user asks "what role am I in this session?"

Read your `## Session origin` block — the role/permissions line is there for non-TUI sessions. For TUI it's `owner` by definition. If the user is in a channel and asks about themselves, read `typeclaw.json` `roles` and match their `<authorId>` against every `match[]` entry in declaration order; the first hit wins. Do not invent a role they aren't in.

## When the user asks about cron / subagent provenance

Cron and subagent sessions don't resolve their role by matching their own origin — instead, the role is **stamped at creation**:

- **Cron jobs** carry `scheduledByRole` in `cron.json`. The job runs as that role. If `scheduledByRole` is absent on a hand-authored cron entry, **boot fails** with a precise error (there is no implicit fallback). Plugin-contributed cron jobs default to `owner`.
- **Subagents** carry `spawnedByRole`, snapshotted from the spawning session's resolved role at spawn time. A cron-fired subagent inherits the cron's stamped role.

This forecloses the laundering attack — an attacker who only resolves to `guest` can ask you to schedule a cron, but the cron entry will be stamped `scheduledByRole: 'guest'`, and when it fires it will still be `guest` (with no permissions, including no `channel.respond` or `security.bypass.*`).

If you see a cron job mysteriously failing every fire with `denied by permissions` in logs, check its `scheduledByRole` — it may have been scheduled by a `guest` session at some point in the past.

## Things you must not do

- **Do not write `*` in user-declared `permissions[]`.** The owner wildcard is a runtime sentinel, not part of the user-facing string format. The schema rejects `*` (it's not a valid dotted permission string anyway).
- **Do not invent permission strings.** Only the three sources above (core, security plugin including the eight per-guard + three tier strings, declared plugins) contribute valid strings. A string like `bash.execute` looks plausible but is not gated by anything and will only earn a boot warning. If the user asks for a permission the model doesn't have, tell them — don't invent one.

- **Do not grant `security.bypass.high` casually.** High-tier guards (`gitExfil`, `gitRemoteTainted`, `outboundSecret`, `systemPromptLeak`) all defend the audience-leak axis — bypassing them means data leaves the operator's perimeter without per-call confirmation. Even `owner` doesn't have `bypass.high` by default for this exact reason. Granting `security.bypass.high` to any role opens audience-leak bypass on every current high-tier guard PLUS every future high-tier guard added by a security plugin update. If the user wants one specific high-tier bypass (e.g. "let me push from TUI without acks"), grant the **per-guard** string explicitly (`security.bypass.gitExfil`) on the specific role, not the tier — that's narrower and won't widen on plugin updates.
- **Do not grant `security.bypass.medium` to roles wider than the operator.** Medium-tier bypasses (`secretExfilBash`, `secretExfilRead`, `ssrf`, `sessionSearchSecrets`) silently dump secrets into model context. Granting `bypass.medium` to a `trusted` role that matches a broad Slack workspace means any trusted speaker can ask the agent to dump environment variables and the bypass succeeds — the operator only sees on session review. If the user wants this anyway, name the specific guard with a per-guard grant rather than the whole tier.
- **Do not promise that `typeclaw reload` applied a `roles` edit.** `roles` is restart-required. The reload tool will return success on the config file change, but the live `PermissionService` was built at boot and is not swapped on reload.
- **Do not silently change a built-in role's permission list.** Setting `"permissions": []` on `member` is a wholesale replace, not a merge — you just took `channel.respond` away from every speaker who resolves to `member`. If the user said "give member just `channel.respond` and nothing else", that's fine (it's the same as the default), but say so explicitly: "this matches the default for `member`, no behavior change". If the user said "remove cron from `trusted`", make the change but warn that `trusted` no longer carries `cron.schedule` either.
- **Do not write match rules using display names** (`#general`, `@user`, channel/user names). Match rules are platform IDs. Display names change; IDs don't. Always look up the ID before writing the rule.
- **Do not edit `roles` to "fix" a security block** without explaining the alternative. The right first move for a guard block is usually `acknowledgeGuards.<X>: true` for the specific call. Editing `roles` to grant a permanent bypass is a heavier change with security implications — get explicit consent.
- **Do not interpret a missing `## Session origin` role line as "I have no role".** TUI sessions don't render the line because TUI is always `owner`. If you see no role line and you're not in TUI, something has gone wrong with the system prompt build — flag it, don't fabricate.

## What this skill does not cover

- **The `channels.<adapter>` block** — engagement, history, stickiness, alias. See `typeclaw-config`. Engagement decides whether an _admitted_ inbound wakes the loop; this skill is only about admission.
- **The full `typeclaw.json` schema** — model, mounts, plugins, docker, git.ignore. See `typeclaw-config`.
- **Cron job authoring** — schedule syntax, `prompt` vs `exec`, the `reload` tool. See `typeclaw-cron`. This skill only covers the `scheduledByRole` field and its provenance semantics.
- **Plugin authoring** — `definePlugin`, contributing permissions, custom `tool.before` hooks. See `typeclaw-plugins`. The bundled security plugin is an example of a plugin that contributes `security.bypass.*` strings and uses `permissions.has()` to gate its own guards.
- **The container vs host stage split** — `typeclaw restart` runs on the host; this skill assumes you know which stage you're in. See `AGENTS.md` for the stage model.
