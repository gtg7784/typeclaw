# Recommended mounts — common host paths

Deep dive on what host paths are worth recommending when the user asks "what should I mount?" or, more often, when the user describes a use case ("I want you to transcribe my voice memos", "help me triage my mail", "look at my screenshots") and you need to know the canonical path, the `readOnly` default, and the platform-specific gotchas before editing `typeclaw.json`.

Read it when `SKILL.md`'s **Mounts** section sends you here. It is **not** a list of mounts to add silently — every recommendation here still requires the user to ask for it. Adding mounts the user did not request is a security surprise (see `SKILL.md` "Things you must not do").

## How to use this file

When the user describes a use case:

1. **Find the matching row below.** If the use case isn't here, fall through to the general procedure in `SKILL.md` (pick a kebab-case name, pick `readOnly`, append the entry, restart-required).
2. **Read the row's platform-specific path.** Apple has moved several of these paths across macOS versions; pick the right one for the user's `sw_vers` (you can ask, or have them run it on the host).
3. **Honor the `readOnly` default.** Most recommendations here lean `readOnly: true` because the use case is "give the agent eyes on this data" not "let the agent rewrite it." If the user explicitly wants read-write, flip it — but say so.
4. **Surface the gotchas before writing.** TCC/Full Disk Access for protected paths, iCloud lazy-download for `Mobile Documents/`, ejection-fragility for `/Volumes/`. Saying "I'll add the mount — note that this path needs Full Disk Access granted to Docker Desktop, otherwise the bind mount succeeds but reads will fail with EPERM" is the whole point of this file.
5. **Then follow the standard Mounts procedure** in `SKILL.md` (read file, check collisions, pick name, append, write, commit, restart-required).

## macOS: Transparency, Consent, Control (TCC) and Full Disk Access

Several juicy macOS paths — Mail, Messages, Calendars (macOS 14+), Contacts, Safari, Reminders, Photos — are gated by macOS's **TCC** subsystem. Apple's rule: the application that opens the file needs to be in System Settings → Privacy & Security → **Full Disk Access** (FDA). For typeclaw, that application is **Docker Desktop** (or **OrbStack** if the user is on OrbStack), because Docker is what mounts the path into the container.

What this means operationally:

- **The mount itself always succeeds.** Docker's bind mount is a kernel-level bind, not a file-open. The agent will see the path appear at `mounts/<name>/` after `typeclaw restart`.
- **`ls` may show files, but `read` returns EPERM.** When FDA is not granted, the container process can stat the directory but fails on actual file `open(2)`. The agent's `read` tool surfaces this as "Permission denied" and the agent looks like it's lying about being able to read the mount.
- **There is no in-container fix.** FDA is a per-application macOS preference set on the host. The user has to open System Settings, find Docker Desktop / OrbStack in Full Disk Access, toggle it on, and **restart Docker** (toggling FDA does not retroactively re-permission a running Docker daemon).

When recommending an FDA-gated path, say so up front: "This requires you to grant Docker Desktop Full Disk Access in System Settings → Privacy & Security, then restart Docker. Without that, I'll see the directory but get EPERM on every file."

OrbStack users: same rule, OrbStack appears in the FDA list as "OrbStack Helper" or "OrbStack" depending on version.

The rows below mark FDA-gated paths with **"FDA"** in the TCC column.

## Tier 1 — high signal, low friction

Use cases the user will ask about often, with paths that don't need TCC grants (or only need the standard Documents/Desktop prompts macOS already pops on first access).

### Voice memos — pairs with the `stt` skill

| Platform      | Path                                                                      | `readOnly` | TCC | Notes                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------- | ---------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS (12+)   | `~/Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings` | `true`     | —   | The group container path. **Not** the old `~/Library/Application Support/com.apple.voicememos` (removed in macOS 12). Includes iCloud-synced recordings from iPhone Voice Memos. |
| macOS (older) | `~/Library/Application Support/com.apple.voicememos/Recordings`           | `true`     | —   | Only on macOS 11 and earlier. If both paths exist on a newer machine, prefer the group container — the old one is a stale copy.                                                  |
| Linux         | (no native equivalent)                                                    | —          | —   | If the user records via `pw-record` / `pactl`, point them at their chosen output dir.                                                                                            |
| WSL           | `/mnt/c/Users/<name>/Documents/Sound recordings/` (Voice Recorder app)    | `true`     | —   | Windows Voice Recorder's default.                                                                                                                                                |

Pair with the `stt` skill — once mounted, the agent can transcribe meetings/notes via Soniox.

### Screenshots — quick visual context

| Platform                | Path                                                              | `readOnly` | TCC | Notes                                                                                                                              |
| ----------------------- | ----------------------------------------------------------------- | ---------- | --- | ---------------------------------------------------------------------------------------------------------------------------------- |
| macOS                   | `~/Desktop` (default)                                             | `true`     | —   | macOS Screenshots default to Desktop. Mount the whole Desktop or filter narrower if the user has a lot of unrelated stuff there.   |
| macOS (custom location) | Run `defaults read com.apple.screencapture location` on the host. | `true`     | —   | Common moved locations: `~/Pictures/Screenshots`, `~/Documents/Screenshots`. Ask the user to run the `defaults` command if unsure. |
| Linux (GNOME)           | `~/Pictures/Screenshots`                                          | `true`     | —   | Default for GNOME Screenshot, KDE Spectacle.                                                                                       |
| WSL                     | `/mnt/c/Users/<name>/Pictures/Screenshots/`                       | `true`     | —   | Windows Win+Shift+S → Snipping Tool save location.                                                                                 |

Useful with multimodal models: "look at this screenshot and explain the error."

### Downloads — ad-hoc file ingestion

| Platform | Path                             | `readOnly`       | TCC | Notes                                                                                                                                                                                                                                                 |
| -------- | -------------------------------- | ---------------- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS    | `~/Downloads`                    | `true` (usually) | —   | "Process the file I just downloaded." Read-only by default — the agent doesn't normally need to write here. macOS may prompt the user once on first container access (TCC prompt for Downloads), but it's a normal user-acknowledged prompt, not FDA. |
| Linux    | `~/Downloads`                    | `true` (usually) | —   | XDG-spec location.                                                                                                                                                                                                                                    |
| WSL      | `/mnt/c/Users/<name>/Downloads/` | `true` (usually) | —   | Windows default Downloads folder.                                                                                                                                                                                                                     |

### Personal notes vault (Obsidian, plaintext, etc.)

| Platform                       | Path                                                                  | `readOnly`                                           | TCC | Notes                                                                                                                                                                                                                                         |
| ------------------------------ | --------------------------------------------------------------------- | ---------------------------------------------------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS — local vault            | `~/Documents/<VaultName>`                                             | `false` (RW for editing) or `true` (RO for research) | —   | If the user wants the agent to edit notes, `false`. If they only want the agent to read/search, `true`. Default to asking.                                                                                                                    |
| macOS — iCloud-synced Obsidian | `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/<VaultName>` | as above                                             | —   | **iCloud lazy-loads.** Files the user hasn't opened recently may appear as 0-byte stubs until iCloud materializes them on access. Tell the user this — they may see the agent report "empty file" on a note that's actually 5KB in the cloud. |
| Linux                          | `~/Documents/<VaultName>` or wherever the user keeps it               | as above                                             | —   | No iCloud quirks.                                                                                                                                                                                                                             |
| WSL                            | `/mnt/c/Users/<name>/Documents/<VaultName>`                           | as above                                             | —   | Be aware of CRLF line endings on files originating from Windows-side editors.                                                                                                                                                                 |

### Code repo — already the canonical example

| Platform | Path                                               | `readOnly`        | TCC | Notes                                                                                                                                                                                                        |
| -------- | -------------------------------------------------- | ----------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| any      | `~/workspace/<repo>` or wherever the user keeps it | `false` typically | —   | The standard "let me code on X" use case. Already covered in the example in `SKILL.md`. The mount is the host repo, so commits inside `mounts/<repo>/` go to the host repo's history (not the agent folder). |

## Tier 2 — privacy-sensitive, FDA-gated

These are powerful but cross a real privacy boundary. **Always recommend `readOnly: true`** unless the user has a specific reason to write. **Always surface the FDA requirement** before editing `typeclaw.json` — the user needs to grant Docker Desktop / OrbStack Full Disk Access on the host, or the mount will read EPERM on every file.

Treat the act of suggesting these as a moment to pause and confirm. They are answers to "I want the agent to triage my mail / search my iMessages / scan my contacts", not defaults.

### macOS Mail — local mailboxes

| Platform                           | Path                                                        | `readOnly` | TCC     | Notes                                                                                                                                                                                |
| ---------------------------------- | ----------------------------------------------------------- | ---------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| macOS 14+ (Sonoma, Sequoia, Tahoe) | `~/Library/Mail/V10`                                        | `true`     | **FDA** | The `V10` directory holds per-account `.mbox`-like dirs containing `.emlx` files (one per message). The format is parseable as RFC822 + a small Apple-specific binary plist trailer. |
| macOS 13 (Ventura)                 | `~/Library/Mail/V9`                                         | `true`     | **FDA** | Same shape, older version dir.                                                                                                                                                       |
| macOS ≤12                          | `~/Library/Mail/V8` or earlier                              | `true`     | **FDA** | Same shape.                                                                                                                                                                          |
| Linux — Thunderbird                | `~/.thunderbird/<profile>.default-release/Mail/`            | `true`     | —       | `.msf` index + `mbox` files. No TCC.                                                                                                                                                 |
| Linux — Evolution                  | `~/.local/share/evolution/mail/`                            | `true`     | —       | Maildir layout. No TCC.                                                                                                                                                              |
| WSL — Outlook (Win32)              | `/mnt/c/Users/<name>/AppData/Local/Microsoft/Outlook/*.pst` | `true`     | —       | PST is a proprietary binary format; the agent needs `libpff` or similar to read it. Not as plug-and-play as `.emlx`. Warn the user.                                                  |

If unsure which `V<n>` the user has, ask them to run `ls ~/Library/Mail/` on the host — there's usually only one.

### iMessage history

| Platform    | Path                                                               | `readOnly` | TCC     | Notes                                                                                                                                                                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------ | ---------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| macOS       | `~/Library/Messages` (the **whole directory**, not just `chat.db`) | `true`     | **FDA** | The history is SQLite at `chat.db`. **Mount the parent dir, not just the db file** — SQLite uses `chat.db-wal` and `chat.db-shm` sidecar files for write-ahead logging, and mounting just `chat.db` will give you a frozen or corrupt-looking snapshot. Attachments live under `Attachments/` inside the same dir. |
| Linux / WSL | —                                                                  | —          | —       | No equivalent (iMessage is Apple-only).                                                                                                                                                                                                                                                                            |

Tell the user: this exposes every iMessage thread on the device. Highly sensitive. Make sure they're sure.

### macOS Calendar (raw CalDAV store)

| Platform    | Path                  | `readOnly` | TCC                   | Notes                                                                  |
| ----------- | --------------------- | ---------- | --------------------- | ---------------------------------------------------------------------- |
| macOS 14+   | `~/Library/Calendars` | `true`     | **FDA**               | TCC began gating Calendars at macOS 14. ICS-format files per calendar. |
| macOS ≤13   | `~/Library/Calendars` | `true`     | — (no FDA prompt yet) | Same path, no FDA needed.                                              |
| Linux / WSL | —                     | —          | —                     | No native equivalent on these platforms.                               |

**Prefer the `gws-calendar` skill** if the user is on Google Workspace — it's API-backed, no FDA, and writes are first-class. This raw mount is for users on iCloud-only or CalDAV (e.g. Fastmail) calendars where Google's API doesn't reach.

### macOS Contacts

| Platform    | Path                                        | `readOnly` | TCC     | Notes                                                                                                     |
| ----------- | ------------------------------------------- | ---------- | ------- | --------------------------------------------------------------------------------------------------------- |
| macOS       | `~/Library/Application Support/AddressBook` | `true`     | **FDA** | SQLite + per-source dirs. Same warning as iMessage on `.db-wal`/`.db-shm` sidecars — mount the whole dir. |
| Linux / WSL | —                                           | —          | —       | No native equivalent.                                                                                     |

Pairs awkwardly with `gws` Google Contacts if the user syncs both — there will be two sources of truth. Ask what they actually want before mounting.

### Safari bookmarks / reading list

| Platform    | Path               | `readOnly` | TCC     | Notes                                                                                                                                                                                                                      |
| ----------- | ------------------ | ---------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS       | `~/Library/Safari` | `true`     | **FDA** | `Bookmarks.plist` (binary plist, parseable with `plutil -convert json` if `plutil` is available, or with a Node plist parser inside the container). Reading list is in the same file. History is in `History.db` (SQLite). |
| Linux / WSL | —                  | —          | —       | No Safari on these platforms. For Chrome/Firefox bookmarks see below.                                                                                                                                                      |

### Browser bookmarks (cross-platform)

| Platform        | Path                                                                          | `readOnly` | TCC | Notes                                                                   |
| --------------- | ----------------------------------------------------------------------------- | ---------- | --- | ----------------------------------------------------------------------- |
| macOS — Chrome  | `~/Library/Application Support/Google/Chrome/Default/Bookmarks`               | `true`     | —   | JSON file. No FDA.                                                      |
| Linux — Chrome  | `~/.config/google-chrome/Default/Bookmarks`                                   | `true`     | —   | Same JSON format.                                                       |
| WSL — Chrome    | `/mnt/c/Users/<name>/AppData/Local/Google/Chrome/User Data/Default/Bookmarks` | `true`     | —   | Same JSON.                                                              |
| macOS — Firefox | `~/Library/Application Support/Firefox/Profiles/<profile>/places.sqlite`      | `true`     | —   | SQLite. Mount the parent profile dir, not just the file (WAL sidecars). |

## Things that look mountable but aren't

Worth knowing because users ask:

- **Apple Notes** (`~/Library/Group Containers/group.com.apple.notes/`) — stored as encrypted SQLite (`NoteStore.sqlite`) with content in protobuf blobs. Even with FDA, the format is not usefully readable without Apple's notes-decryption logic. The clean path is **export from Apple Notes app** (File → Export → PDF/HTML) into a regular directory, then mount that. Alternative: AppleScript / `osascript` driven from the host. Don't recommend mounting the raw container.
- **Photos library** (`~/Pictures/Photos Library.photoslibrary`) — a `.photoslibrary` package containing SQLite metadata and a content-addressed blob store. Mountable, but reading photos by user-visible name requires querying `Photos.sqlite` and joining against the blob store. Recommend the user **export albums** to a flat dir, or use `osxphotos` on the host to dump metadata. Like Notes, the raw package isn't agent-friendly.
- **macOS Mail attachments** — these live inside the `V10/` tree but are split across per-message `.mbox` directories under `Attachments/`. They're materialized lazily when Mail downloads them; messages opened only briefly may have no local attachment. Telling the user "I'll grab the attachment from that email" only works for emails Mail.app has fully cached.
- **Keychain** (`~/Library/Keychains/`) — encrypted blobs, useless to read directly, very sensitive. Never recommend.

## Dev / workflow staples — minor but worth mentioning

Quick wins that solve common questions without being privacy-loaded.

| Use case                      | Path                                                                     | `readOnly` | Notes                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Shell history                 | `~/.zsh_history` or `~/.bash_history` (mount the file or its parent dir) | `true`     | "What command did I run yesterday?" Mounting the parent (`~`) is **not** the answer — mount the specific file.                   |
| SSH **config** (NOT keys)     | `~/.ssh/config`                                                          | `true`     | Single file. Useful for "ssh me into the staging box you set up." **Never mount `~/.ssh/` wholesale** — private keys live there. |
| Git config                    | `~/.gitconfig`                                                           | `true`     | Lets the agent see the user's identity, aliases, signing config.                                                                 |
| Time Machine-excluded scratch | `~/scratch` (user creates with `tmutil addexclusion ~/scratch`)          | `false`    | Ephemeral agent output the user doesn't want backed up.                                                                          |
| iCloud Drive top-level        | `~/Library/Mobile Documents/com~apple~CloudDocs`                         | mixed      | iCloud lazy-loads — same warning as the Obsidian iCloud row above.                                                               |

## Anti-patterns

Append-only list, no overlap with `SKILL.md`'s existing anti-patterns (which cover schema/correctness, not host-path safety):

- **Never recommend mounting `~` (the entire home directory).** It's tempting and it's a security disaster: SSH keys, browser cookies, app credentials, `.env` files from every project, shell history with leaked tokens, Keychain blobs. If the user asks for "everything", push back and ask what they actually need.
- **Never mount `~/.ssh/` wholesale.** Private keys (`id_*`, `id_*.pub` ok but the bare files without `.pub` are private) should not enter the container. Mount the specific file `~/.ssh/config` read-only if the user wants SSH host visibility.
- **Never mount `~/Library/Keychains/`.** Even read-only, even with FDA. The keychain is encrypted blobs the agent can't use, and the act of bind-mounting it expands the attack surface for no benefit.
- **Never mount `~/.aws/`, `~/.gcp/`, `~/.azure/`, or any cloud-CLI credential dir.** Same reasoning as keychains — credentials, not data. If the user wants the agent to do cloud work, plumb credentials through `.env` (env vars the cloud SDK reads), not through a bind mount of the secret store.
- **`/Volumes/<external-drive>` is fragile.** Bind mounts to removable drives don't recover when the drive is ejected — the container sees the path become an empty stub, and the only fix is `typeclaw restart` after the drive is reattached. Tell the user before mounting, and consider whether copying the data to an internal path is wiser.
- **iCloud Drive paths lazy-load.** `~/Library/Mobile Documents/com~apple~CloudDocs/` and the per-app `iCloud~<bundle>` dirs only materialize files when the host system opens them. Inside the container, an unmaterialized file appears as a 0-byte stub or a `.icloud` placeholder. The fix is host-side: have the user open the file (or `brctl download` it) before the agent tries to read it. The agent cannot trigger iCloud materialization from inside the container.
- **`/private/var/db/` and other system stores are not yours.** TCC database, Spotlight metadata, system logs — all gated by SIP (System Integrity Protection) on top of FDA, and none of them are useful to the agent. If the user asks for Spotlight-style search, the answer is `mdfind` from the host (out of scope for the container), not a mount.
- **Don't mount the same host path twice under different mount names.** Docker allows it, but the agent now has two views of the same data and writes through one are immediately visible through the other. It looks like a bug from the agent's side ("why did `mounts/notes-ro/foo.md` change when I wrote `mounts/notes-rw/foo.md`?"). Pick one mount per host path.
- **`readOnly: true` is not encryption-at-rest.** A read-only mount prevents the agent from writing back, but reads still happen through the kernel's normal file path — no obfuscation, no privacy gain beyond write-prevention. If the data is so sensitive that read-access itself is a problem, the answer is **don't mount it**, not "mount it read-only".
- **macOS path versioning will drift.** Apple has moved `~/Library/Mail/V<n>`, Voice Memos, and other paths across macOS versions. The paths in this file are good for macOS 12–26 as of this writing; if a future macOS reorganization breaks one, the symptom is `ls mounts/<name>` returning empty after a successful mount. Update this file, don't paper over it.

## When the path you need isn't here

Fall through to the general procedure in `SKILL.md`. If it's a use case you've handled successfully and it generalizes (other users would benefit), update this file in the same edit — the recommended-mounts list is meant to grow over time as the agent learns common asks.
