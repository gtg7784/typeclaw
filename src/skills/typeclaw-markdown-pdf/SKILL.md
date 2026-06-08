---
name: typeclaw-markdown-pdf
description: "The ONLY supported way to turn Markdown into a polished, professional PDF (and optionally attach it to a channel). Load this whenever you need to deliver a document as a PDF rather than raw markdown — reports, summaries, briefs, meeting notes, docs, render report, export document, anything a human would want to download, print, or forward, including a researcher's report file shipped as a Slack/Discord attachment. Triggers: 'make a PDF', 'export to PDF', 'markdown to PDF', 'PDF report', 'render report', 'export document', 'the report', 'attach the report', 'send me a PDF', 'as a PDF', 'turn this into a document', a researcher/subagent result you want to ship as a file, 'PDF로', 'PDF로 만들어', 'PDF로 변환', 'PDF 첨부', '리포트', '보고서'. Handles CJK/Korean/Japanese/Chinese: CJK fonts are opt-in, so before rendering it checks whether a CJK font is present and, if not, asks the user to enable `docker.file.cjkFonts` and regenerate rather than shipping a tofu PDF — it never auto-downloads a font. Also load before saying you cannot produce PDFs — you can: this skill installs a tiny Typst toolchain into workspace/ on first use, then renders. NEVER build a PDF with jsPDF, pdfkit, a canvas text dump, or a headless-browser raw-text print — those produce unrendered markdown and broken CJK; this skill is the only correct path. Covers the one-time setup, the styled wrapper, the render command, and how to attach the PDF to Slack/Discord/Telegram/KakaoTalk. For operating on EXISTING PDFs (merge, split, extract text, fill forms), this is not the skill — use pypdf/qpdf instead."
---

# typeclaw-markdown-pdf

You can produce professional PDFs from Markdown. This skill installs a small,
self-contained [Typst](https://typst.app) toolchain into your `workspace/` the
**first time** you need a PDF, then reuses it. No Pandoc, no LaTeX, no headless
browser — just an npm-installed Typst compiler plus the
[`cmarker`](https://typst.app/universe/package/cmarker/) package that reads your
Markdown.

The flow is: **(1)** run the one-time setup (`bun add` the Typst compiler +
vendor `cmarker` into `workspace/.tools/`), **(2)** write a styled `.typ` wrapper
that reads your Markdown, **(3)** run the render script. If a channel asked for
the PDF, attach the result with `channel_send`.

You do **not** need to learn Typst markup. `cmarker` renders your CommonMark
(headings, lists, tables, code, blockquotes, footnotes, links, images). The
wrapper only sets _styling_ — fonts, margins, headings, page numbers — so the
output looks deliberate, not like a default-template export.

> **This is the only supported way to make a PDF from Markdown in TypeClaw.**
> Do **not** reach for `jsPDF`, `pdfkit`, a `<canvas>` text dump, or a
> headless-browser "print raw text" path. Those skip Markdown rendering (you get
> literal `##` and `**` in the output) and ship no CJK font, so Korean/Japanese/
> Chinese come out as mojibake. The Typst path below renders the Markdown properly;
> for CJK it relies on the opt-in `cjkFonts` font and gates on its presence (see
> "## Handling CJK content") rather than shipping tofu. If you catch yourself about
> to `bun add` a PDF library, stop and use this skill instead.

## When to use this

- A research report, brief, or summary the user wants as a downloadable file.
- A subagent (e.g. the `researcher`) handed you a `research-<slug>.md` to ship as a PDF.
- Any channel message asking for "a PDF" / "the report attached" / "PDF로 보내줘".

When plain markdown in chat is fine, **don't** make a PDF. This is for when a
_file_ is the deliverable.

## Step 0 — one-time setup (install the toolchain)

Run this `bash` block once per container life. It is **idempotent** — if the
tools are already present it does nothing and exits fast. It `bun add`s the
version-pinned Typst compiler (npm pulls only this platform's prebuilt binary —
Linux x64/arm64, glibc or musl) and vendors the SHA256-verified `cmarker` package
into `workspace/.tools/` so `@preview/cmarker` resolves offline.

```sh
set -eu
cd workspace
mkdir -p .tools
cd .tools

# Pinned to the exact versions validated for this skill. COMPILER_VERSION is the
# npm package version of the Typst compiler; it embeds Typst 0.14.2. Bumping
# either is a deliberate edit — keep the embedded-Typst note below in sync.
COMPILER_VERSION="0.7.0"   # @myriaddreamin/typst-ts-node-compiler (embeds Typst 0.14.2)
CMARKER_VERSION="0.1.8"
PKGDIR="typst-packages/preview/cmarker/$CMARKER_VERSION"

if [ -f "node_modules/@myriaddreamin/typst-ts-node-compiler/package.json" ] && [ -f "$PKGDIR/lib.typ" ]; then
  echo "markdown-pdf toolchain already installed"
else
  # The Typst compiler, version-pinned. `bun add` resolves the right prebuilt
  # NAPI binary for this platform via optionalDependencies — no Rust toolchain,
  # no manual download. The exact pin keeps the toolchain reproducible: a future
  # npm release can't silently change the embedded Typst version or the API that
  # Step 3 depends on.
  [ -f package.json ] || echo '{"name":"typeclaw-markdown-pdf-tools","private":true}' > package.json
  bun add "@myriaddreamin/typst-ts-node-compiler@$COMPILER_VERSION"

  # cmarker (Markdown -> Typst), vendored so compilation needs no network.
  mkdir -p "$PKGDIR"
  curl -fsSL -o cmarker.tar.gz \
    "https://packages.typst.org/preview/cmarker-$CMARKER_VERSION.tar.gz"
  echo "157cc40db2716f12c7eabb95df1f60714a4d95ebfb1c6087cf4aec224e49392a  cmarker.tar.gz" | sha256sum -c -
  tar -xzf cmarker.tar.gz -C "$PKGDIR"
  rm cmarker.tar.gz
  echo "markdown-pdf toolchain installed"
fi
```

Notes:

- It writes only under `workspace/`, the directory your `bash`/`write` tools can
  write to. `workspace/.tools/` is gitignored scratch — it does not get committed.
- It needs network the first time (to `bun add` the compiler + fetch the package).
  After that the tools persist for the life of the container.
- **Everything is version-pinned and reproducible.** The validated toolchain is
  `@myriaddreamin/typst-ts-node-compiler@0.7.0` (which embeds Typst **0.14.2**) and
  `cmarker@0.1.8` (SHA256-verified). The `bun add` uses the exact `@0.7.0` pin, so
  a future npm release can't change the embedded Typst version or the API Step 3
  uses. To upgrade, bump both `COMPILER_VERSION` and the embedded-Typst note
  together after re-validating.

## Step 1 — have the markdown ready

Use an existing markdown file (yours or a subagent's), or `write` your content to
`workspace/<slug>.md`. Standard CommonMark plus tables and footnotes all work.

## Step 2 — write the styled wrapper

`write` this to `workspace/<slug>.typ`, changing only the `read("...")` filename
to match your markdown. The defaults are a clean, professional house style; adjust
fonts/margins only if the user asks.

```typst
#set document(title: "Report")
#set page(
  paper: "a4",
  margin: (x: 2.5cm, y: 2.75cm),
  numbering: "1",
  footer: context align(center, text(size: 9pt, fill: luma(120))[
    #counter(page).display("1 / 1", both: true)
  ]),
)
#set text(font: ("Libertinus Serif", "New Computer Modern", "Noto Serif CJK KR"), size: 11pt, lang: "en")
#set par(justify: true, leading: 0.68em, spacing: 1.1em)

#show heading: set text(weight: "semibold")
#show heading.where(level: 1): it => block(width: 100%, above: 1.4em, below: 0.9em)[
  #text(size: 1.5em, it.body)
  #v(-0.4em)
  #line(length: 100%, stroke: 0.5pt + luma(200))
]
#show link: it => text(fill: rgb("#1a56db"), underline(it))
#show quote.where(block: true): it => block(
  inset: (left: 1em), stroke: (left: 2pt + luma(200)),
  text(style: "italic", fill: luma(80), it.body),
)
#show raw.where(block: true): it => block(
  fill: luma(245), inset: 8pt, radius: 4pt, width: 100%, text(size: 9pt, it),
)
#show table: set table(stroke: 0.5pt + luma(200))

#import "@preview/cmarker:0.1.8"
#cmarker.render(read("report.md"), h1-level: 1, blockquote: quote.with(block: true))
```

Notes:

- `read("report.md")` is **relative to the workspace** (the compiler's `workspace`
  is set to `workspace/` — see Step 3). Keep the `.typ` and `.md` in `workspace/`.
- Fonts `Libertinus Serif` / `New Computer Modern` are bundled with Typst (no font
  install) and carry the Latin text. `"Noto Serif CJK KR"` is appended as the
  fallback so Korean/CJK glyphs resolve per-glyph — Typst falls through to it
  wherever the Latin fonts have no glyph, leaving Latin runs untouched. It comes
  from `fonts-noto-cjk`, which Step 3's renderer loads from `/usr/share/fonts` via
  `fontPaths`. **The package is only present when the container's `cjkFonts` toggle
  resolves to `true`** (default `"auto"` installs it only on a CJK host locale), so
  on a non-CJK host CJK text renders as tofu — see "## Handling CJK content" below
  for the pre-render check that catches this and asks the user before shipping a
  broken PDF. If your CJK font lives elsewhere, add its dir to the `fontPaths` list.

## Handling CJK content

CJK fonts are **opt-in** (the `docker.file.cjkFonts` toggle). When they are off,
Typst still renders — it just substitutes `.notdef` tofu boxes for every
Korean/Japanese/Chinese glyph, so the render "succeeds" and you can ship a broken
PDF without noticing. **Do not** download, vendor, or `curl` a font into the
workspace to work around this, and **do not** silently deliver a tofu PDF. Instead,
run this gate **before** Step 3 whenever the markdown might contain CJK:

```sh
# Run from workspace/. MD is the markdown you are about to render.
MD="report.md"

# Hangul, Kana, CJK ideographs + the common extensions. grep -P on Debian; perl
# slurp as the fallback (BusyBox/macOS grep lack -P).
CJK_RE='[\x{1100}-\x{11FF}\x{3130}-\x{318F}\x{AC00}-\x{D7A3}\x{3040}-\x{30FF}\x{31F0}-\x{31FF}\x{3400}-\x{4DBF}\x{4E00}-\x{9FFF}\x{F900}-\x{FAFF}\x{20000}-\x{2A6DF}\x{2A700}-\x{2B73F}\x{2B740}-\x{2B81F}\x{2B820}-\x{2CEAF}\x{2CEB0}-\x{2EBEF}\x{30000}-\x{3134F}]'
if command -v grep >/dev/null && echo | grep -qP '' 2>/dev/null; then
  LC_ALL=C.UTF-8 grep -qP "$CJK_RE" -- "$MD" && HAS_CJK=1 || HAS_CJK=0
else
  perl -CSDA -0777 -ne "exit(/$CJK_RE/ ? 0 : 1)" "$MD" && HAS_CJK=1 || HAS_CJK=0
fi

# A CJK font Typst can load. dpkg is the authoritative signal for the opt-in
# fonts-noto-cjk package; the file scan covers a preinstalled or mounted font.
# fontconfig/fc-list is NOT consulted — Typst reads fontPaths directly, not fc.
has_cjk_font() {
  dpkg-query -W -f='${Status}' fonts-noto-cjk 2>/dev/null | grep -q 'install ok installed' && return 0
  find /usr/share/fonts /usr/local/share/fonts -type f \( -iname '*.otf' -o -iname '*.ttf' -o -iname '*.ttc' \) 2>/dev/null |
    grep -Eiq '(Noto(Sans|Serif)CJK|Noto (Sans|Serif) CJK|SourceHan|Source Han|WenQuanYi|Nanum|Unifont|DroidSansFallback|AR PL)'
}

if [ "$HAS_CJK" = 1 ] && ! has_cjk_font; then
  echo "CJK_FONT_MISSING"
fi
```

If the gate prints `CJK_FONT_MISSING`, **stop — do not render or attach a PDF.**
Tell the user, honestly, that this is a restart-required boot setting, e.g.:

> This report has Korean/Japanese/Chinese text, but the container has no CJK font
> — they're opt-in, so the PDF would come out as tofu boxes. Want me to set
> `docker.file.cjkFonts: true` in `typeclaw.json`? It's a boot setting, so after I
> edit it you'll need to run `typeclaw restart` from the host project directory,
> and then I'll regenerate the PDF.

Only after the user agrees: edit `typeclaw.json` to set `docker.file.cjkFonts:
true` (use the `typeclaw-config` skill), ask them to `typeclaw restart`, and
regenerate the PDF **after** the restarted container reports `has_cjk_font` true.
If the markdown has no CJK, or a CJK font is present, skip straight to Step 3.

## Step 3 — render

`write` this tiny renderer to `workspace/.tools/render.ts`, then run it. It loads
the npm-installed compiler, points the package cache at the vendored `cmarker`, and
writes the PDF. Pass the wrapper and output paths as arguments.

```ts
// workspace/.tools/render.ts
import { NodeCompiler } from '@myriaddreamin/typst-ts-node-compiler'
import { existsSync, writeFileSync } from 'node:fs'

const [, , mainFile, outFile] = process.argv
if (!mainFile || !outFile) throw new Error('usage: render.ts <main.typ> <out.pdf>')

// Load system fonts so CJK glyphs resolve. The compiler does NOT auto-discover
// system font dirs the way the Typst CLI does — without explicit fontPaths,
// "Noto Serif CJK KR" (from fonts-noto-cjk under /usr/share/fonts) is invisible
// and Korean/Japanese/Chinese text renders as .notdef tofu boxes. Filtered with
// existsSync so a missing dir (e.g. on a dev/host run) is skipped, not fatal.
const fontPaths = ['/usr/share/fonts', '/usr/local/share/fonts', '/Library/Fonts', '/System/Library/Fonts'].filter(
  existsSync,
)

const compiler = NodeCompiler.create({
  workspace: '.', // run from workspace/, so read("report.md") resolves
  ...(fontPaths.length > 0 ? { fontArgs: [{ fontPaths }] } : {}),
})
const pdf = compiler.pdf({ mainFilePath: mainFile })
writeFileSync(outFile, Buffer.from(pdf))
console.log(`wrote ${outFile} (${pdf.length} bytes)`)
```

Run it from `workspace/`, with the package cache pointed at the vendored packages:

```sh
cd workspace
TYPST_PACKAGE_CACHE_PATH="$PWD/.tools/typst-packages" \
TYPST_PACKAGE_PATH="$PWD/.tools/typst-packages" \
  bun .tools/render.ts report.typ report.pdf
```

Verify: the command prints `wrote report.pdf (...)` and `workspace/report.pdf`
exists. On a compile error the compiler throws with the offending Typst line —
usually raw HTML or a markdown extension `cmarker` doesn't support; simplify that
part and re-run.

## Rich elements (optional)

When plain markdown isn't enough — you want a cover banner, callout boxes,
multi-column sections, captioned figures — you don't switch to HTML (Typst
doesn't render HTML). Instead, drop **raw Typst** into the markdown via
`<!--raw-typst ... -->` comments. `cmarker` evaluates them as Typst (the
`raw-typst: true` option is already the default and is set in the wrapper above).
The rest of the document stays plain markdown.

Each snippet below is self-contained — paste it into your `.md` where you want the
element. They use Typst built-ins only (no extra packages).

**Cover banner** (top of a report):

```markdown
<!--raw-typst
#block(width: 100%, fill: rgb("#0f172a"), inset: 18pt, radius: 6pt)[
  #text(fill: white, size: 1.6em, weight: "bold")[Quarterly Business Review]
  #v(2pt)
  #text(fill: rgb("#94a3b8"), size: 0.95em)[Acme Robotics · Q2 2026 · Confidential]
]
#v(1em)
-->
```

**Callout boxes** (info / warning — change the two colors for other variants):

```markdown
<!--raw-typst
#block(fill: rgb("#eff6ff"), stroke: (left: 3pt + rgb("#3b82f6")), inset: 12pt, radius: 4pt, width: 100%)[
  #text(weight: "bold")[Note.] Revenue grew 31% YoY.
]
#v(0.6em)
#block(fill: rgb("#fef2f2"), stroke: (left: 3pt + rgb("#ef4444")), inset: 12pt, radius: 4pt, width: 100%)[
  #text(weight: "bold")[Risk.] A single supplier covers 40% of NPUs.
]
-->
```

**Two-column section** (use `#colbreak()` to split):

```markdown
<!--raw-typst
#columns(2, gutter: 1.4em)[
  #text(weight: "bold")[Strengths]
  - Net retention 124%
  - Margin +240bps
  #colbreak()
  #text(weight: "bold")[Risks]
  - Supplier concentration
  - Partial FX hedging
]
-->
```

**Figure with caption** (swap the `rect(...)` for `image("chart.png")` to embed an
image written to `workspace/`):

```markdown
<!--raw-typst
#figure(
  rect(width: 60%, height: 48pt, fill: luma(245), stroke: 0.5pt + luma(180)),
  caption: [Revenue trend, Q1–Q2 2026.],
)
-->
```

**Definition grid** (label column + description column):

```markdown
<!--raw-typst
#grid(columns: (auto, 1fr), row-gutter: 6pt, column-gutter: 12pt,
  text(weight: "bold")[NPU], [Neural processing unit — on-device inference accelerator.],
  text(weight: "bold")[Net retention], [Revenue from existing customers vs. a year ago.],
)
-->
```

Keep it tasteful — a banner, a couple of callouts, and one good figure read as
deliberate; a wall of colored boxes reads as noise.

## Rendering an _existing_ web page or HTML to PDF

This skill renders **markdown you author**. If instead you need to capture an
**existing web page or a live URL** as a PDF — something Typst cannot do — use the
already-installed `agent-browser` (Chrome): `agent-browser --allow-file-access open
file:///agent/workspace/page.html` (or a URL), then `agent-browser pdf
/agent/workspace/out.pdf`. Note its output is fixed US-Letter with default margins
(no page-size flags), and launching the browser needs a trusted/owner session — so
it's the right tool for _archiving web content_, not for authoring styled reports.
For authored documents, stay on the Typst path above.

## Step 4 — deliver

- **Channel asked for the PDF** — attach it:

  ```
  channel_send(text: "Here's the report.", attachments: [{ path: "/agent/workspace/report.pdf", filename: "Edge-AI-Brief.pdf" }])
  ```

  Use a human-friendly `filename` and an absolute `/agent/workspace/...` path. Slack,
  Discord, Telegram, and KakaoTalk upload the file; the GitHub adapter has no
  attachment support, so there post a link or paste the markdown.

- **Replying in a thread** — use `channel_reply` with the same `attachments` shape.

- **No channel** (TUI session) — just report the path: `workspace/report.pdf`.

## If you got the markdown from a subagent

The `researcher` subagent writes its report to `workspace/research-<slug>.md` and
returns a `<report>` block naming the file. Point the wrapper's `read(...)` at that
file, render, and attach. You do the PDF step — the researcher's `bash` is
read-only and it only emits markdown by design.

## Customizing this skill

This is a bundled default. Want a different house style, a different converter, or
a cover page with a logo? Copy this file to `.agents/skills/<your-name>/SKILL.md`
(use a **different** `name`; bundled skills win name collisions) and edit the setup
or the wrapper there. Because the whole pipeline — install + render — lives in the
skill, you can change either half without touching the container image.

## Known limitations

`cmarker` covers CommonMark well, but a few markdown features don't render as you
might expect:

- **Task-list checkboxes** (`- [ ]` / `- [x]`) render as literal `[ ]` text, not
  checkboxes. Use a plain bullet list or a status column in a table instead.
- **Bold/italic directly adjacent to CJK + parenthetical Latin** (e.g.
  `**로컬 우선(local-first)**`) may not be recognized as emphasis — CommonMark's
  flanking rules treat that boundary as non-emphasis. Put a space inside, or bold a
  pure run of text.
- **Raw HTML** in the markdown is mostly ignored. Express structure in markdown
  (tables, lists) rather than HTML.

## Don'ts

- **Don't** hand-write Typst markup for the body. Let `cmarker` render the
  markdown; only style via `#set` / `#show` rules in the wrapper.
- **Don't** write the `.typ`, `.md`, `.pdf`, or `.tools/` outside `workspace/` —
  the sandbox blocks it.
- **Don't** re-run Step 0's install if the tools already exist — the guard at the
  top skips it. Re-installing every time is wasteful.
- **Don't** attach a PDF to a GitHub channel — that adapter rejects attachments.
  Link or inline instead.
