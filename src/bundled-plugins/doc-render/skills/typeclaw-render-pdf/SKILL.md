---
name: typeclaw-render-pdf
description: "The ONLY supported way to render Markdown into a polished, professional PDF (and optionally attach it to a channel). Load this whenever you need to deliver a document as a PDF rather than raw markdown — reports, summaries, briefs, meeting notes, docs, render report, export document, anything a human would want to download, print, or forward, including a researcher's report file shipped as a Slack/Discord attachment. Triggers: 'make a PDF', 'export to PDF', 'markdown to PDF', 'PDF report', 'render report', 'export document', 'the report', 'attach the report', 'send me a PDF', 'as a PDF', 'turn this into a document', a researcher/subagent result you want to ship as a file, 'PDF로', 'PDF로 만들어', 'PDF로 변환', 'PDF 첨부', '리포트', '보고서'. Provided by the bundled `doc-render` plugin: a small Typst toolchain is installed on first use via `bun add` (no PDF library is baked into the image), and a bundled render script does the compile. Handles CJK/Korean/Japanese/Chinese: CJK fonts are opt-in, so if the output has tofu (□□□) boxes it tells you to enable `docker.file.cjkFonts` and restart, then regenerates — it never auto-downloads a font. Also load before saying you cannot produce PDFs — you can. NEVER build a PDF with jsPDF, pdfkit, a canvas text dump, a headless-browser raw-text print, or Python ReportLab — those produce unrendered markdown and broken CJK; this skill is the only correct path. Covers the one-time install, the styled wrapper, the render command, and how to attach the PDF to Slack/Discord/Telegram/KakaoTalk. For operating on EXISTING PDFs (merge, split, extract text, fill forms), this is not the skill — use pypdf/qpdf instead; doc-render produces documents, it does not read them."
---

# typeclaw-render-pdf

You can produce professional PDFs from Markdown. The bundled `doc-render` plugin
ships the render script; the only thing installed on demand is the
[Typst](https://typst.app) compiler — a single npm package the agent `bun add`s
into its own `node_modules` the **first time** you need a PDF, then reuses. No
Pandoc, no LaTeX, no headless browser, and no PDF toolchain baked into the image.

The flow is: **(1)** install the compiler once (`bun add` — it lands in the
agent's `node_modules`, surviving restarts), **(2)** write a styled `.typ`
wrapper that reads your Markdown, **(3)** run the bundled render script. If a
channel asked for the PDF, attach the result with `channel_send`.

You do **not** need to learn Typst markup. The
[`cmarker`](https://typst.app/universe/package/cmarker/) package renders your
CommonMark (headings, lists, tables, code, blockquotes, footnotes, links,
images). The wrapper only sets _styling_ — fonts, margins, headings, page numbers
— so the output looks deliberate, not like a default-template export.

> **This is the only supported way to make a PDF from Markdown in TypeClaw.**
> Do **not** reach for `jsPDF`, `pdfkit`, a `<canvas>` text dump, a
> headless-browser "print raw text" path, or Python `ReportLab`. Those skip
> Markdown rendering (you get literal `##` and `**` in the output) and ship no
> CJK font, so Korean/Japanese/Chinese come out as mojibake. The Typst path below
> renders the Markdown properly. If you catch yourself about to `bun add` a PDF
> library other than the Typst compiler named here, stop.

## When to use this

- A research report, brief, or summary the user wants as a downloadable file.
- A subagent (e.g. the `researcher`) handed you a `research-<slug>.md` to ship as a PDF.
- Any channel message asking for "a PDF" / "the report attached" / "PDF로 보내줘".

When plain markdown in chat is fine, **don't** make a PDF. This is for when a
_file_ is the deliverable.

## Step 0 — install the Typst compiler (once per container)

The PDF compiler is not baked into the image — install it on first use. It is a
single version-pinned npm package (npm pulls only this platform's prebuilt
binary — Linux x64/arm64, glibc or musl). It writes to the agent's
`node_modules` + `package.json` + `bun.lock`, all of which survive restarts, so
this only runs once per container life:

```sh
# Idempotent: bun add is a no-op if it's already the installed version.
bun add @myriaddreamin/typst-ts-node-compiler@0.7.0
```

The `@0.7.0` pin embeds Typst 0.14.2 and keeps the toolchain reproducible — a
future npm release can't silently change the embedded Typst version or the API
the render script depends on. If you forget this step, the render script in
Step 3 stops with the exact `bun add` line to run, so you can also just try the
render and follow its guidance.

> **Where it goes:** the agent's own `node_modules` — the canonical home for
> executable dependencies, gitignored, not user-facing. Do **not** create a
> `package.json` or `node_modules` under `workspace/` for this; let `bun add`
> manage it at the agent root like any other dependency.

## Step 1 — have the markdown ready

Use an existing markdown file (yours or a subagent's), or `write` your content to
a markdown file. Standard CommonMark plus tables and footnotes all work. Put the
`.md` and the `.typ` (Step 2) in the same directory so the wrapper's relative
`read("...")` resolves — any agent-writable directory works (`workspace/`,
`public/`, `mounts/`, or wherever the source `.md` already lives, e.g. a
researcher's report under `public/`). There is no required directory; keep the
two files together and run the render from there.

## Step 2 — write the styled wrapper

`write` a `.typ` next to your markdown, pointing `read("...")` at the markdown
filename. The wrapper below is a clean, professional **starting point** — not a
fixed template. Design the document to fit its content and audience: a dense
technical brief wants tighter margins than an airy exec summary; a launch report
might open with a cover banner. Adjust fonts, spacing, and structure freely, and
reach for the **Rich elements** palette below when plain prose isn't enough.

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

- `read("report.md")` is **relative to the render's working directory**, so Step 3
  `cd`s into the directory holding the `.typ` and `.md` before running. Keep them
  together.
- Fonts `Libertinus Serif` / `New Computer Modern` are bundled with Typst (no font
  install) and carry the Latin text. `"Noto Serif CJK KR"` is appended as the
  fallback so Korean/CJK glyphs resolve per-glyph wherever the Latin fonts have no
  glyph, leaving Latin runs untouched. It is only present when the container's
  `cjkFonts` toggle is on — see "## Handling CJK content".
- `cmarker` fetches from the Typst package registry on first compile (the same
  network the `bun add` step needs). It caches under the render's `$HOME`, which
  in a sandboxed (channel/guest) session is per-session scratch — so a later
  session may re-fetch it. That's a one-time network hit, not an error.

## Step 3 — render

The render script is **bundled with the plugin** — you do not write it. It lives
at `/agent/node_modules/typeclaw/src/bundled-plugins/doc-render/render.ts`.

**`cd` into the directory holding your `.typ` and `.md` first** — your shell
starts at the agent root, and the wrapper's `read("report.md")` resolves relative
to the render's working directory, so you must run it from there:

```sh
cd /agent/workspace            # or wherever your .typ + .md live (public/, mounts/, …)
bun run /agent/node_modules/typeclaw/src/bundled-plugins/doc-render/render.ts report.typ report.pdf
```

On success it prints `wrote report.pdf (<N> bytes)` and `report.pdf` exists in
that directory.

If it stops with **`@myriaddreamin/typst-ts-node-compiler is not installed`**
(exit 3), run the Step 0 `bun add` and re-run. If it stops with a **`NotDir` /
ENOTDIR** error, that is the sandbox `/proc` degraded mode, not your markup and
not a font — retry once; if it persists, report it as a sandbox/environment
issue and do **not** switch to another PDF library (it won't help). Any other
error is a real Typst compile error (usually raw HTML or an unsupported markdown
extension) and names the offending line — simplify that part and re-run.

## Handling CJK content

CJK fonts are **opt-in** (the `docker.file.cjkFonts` toggle). When they are off,
Typst still renders — it just substitutes `.notdef` tofu (□) boxes for every
Korean/Japanese/Chinese glyph. **Do not** download, vendor, or `curl` a font to
work around this, and **do not** silently deliver a tofu PDF.

You don't need a pre-render gate: render first, then verify. If the source
markdown contains CJK and the resulting PDF shows tofu boxes (or you know CJK
fonts aren't enabled on this container), tell the user honestly and offer the
fix:

> This report has Korean/Japanese/Chinese text but the container has no CJK font
> — they're opt-in, so the PDF comes out as tofu boxes. Want me to set
> `docker.file.cjkFonts: true` in `typeclaw.json`? It's a boot setting, so after
> I edit it you'll run `typeclaw restart` from the host project directory, and
> then I'll regenerate the PDF.

Only after the user agrees: edit `typeclaw.json` to set `docker.file.cjkFonts:
true` (use the `typeclaw-config` skill), ask them to `typeclaw restart`, and
regenerate the PDF after the restarted container comes back. If the markdown has
no CJK, this section doesn't apply.

## Rich elements (optional)

When plain markdown isn't enough — a cover banner, callout boxes, multi-column
sections, captioned figures — you don't switch to HTML (Typst doesn't render
HTML). Instead, drop **raw Typst** into the markdown via `<!--raw-typst ... -->`
comments. `cmarker` evaluates them as Typst (the `raw-typst: true` option is the
default). The rest of the document stays plain markdown.

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
image written next to the markdown):

```markdown
<!--raw-typst
#figure(
  rect(width: 60%, height: 48pt, fill: luma(245), stroke: 0.5pt + luma(180)),
  caption: [Revenue trend, Q1–Q2 2026.],
)
-->
```

Keep it tasteful — a banner, a couple of callouts, and one good figure read as
deliberate; a wall of colored boxes reads as noise.

## Rendering an _existing_ web page or HTML to PDF

This skill renders **markdown you author**. To capture an **existing web page or
a live URL** as a PDF — something Typst cannot do — use the already-installed
`agent-browser` (Chrome): `agent-browser --allow-file-access open
file:///agent/workspace/page.html` (or a URL), then `agent-browser pdf
/agent/workspace/out.pdf`. Its output is fixed US-Letter with default margins, so
it's the right tool for _archiving web content_, not for authoring styled
reports. For authored documents, stay on the Typst path above.

## Step 4 — deliver

- **Channel asked for the PDF** — attach it:

  ```
  channel_send(text: "Here's the report.", attachments: [{ path: "/agent/workspace/report.pdf", filename: "Edge-AI-Brief.pdf" }])
  ```

  Use a human-friendly `filename` and an absolute path. Slack, Discord, Telegram,
  and KakaoTalk upload the file; the GitHub adapter has no attachment support, so
  there post a link or paste the markdown.

- **Replying in a thread** — use `channel_reply` with the same `attachments` shape.

- **No channel** (TUI session) — just report the path: `report.pdf`.

## If you got the markdown from a subagent

The `researcher` subagent writes its report to `research-<slug>.md` and returns a
`<report>` block naming the file. Point the wrapper's `read(...)` at that file,
render in that file's directory, and attach. You do the PDF step — the
researcher's `bash` is read-only and it only emits markdown by design.

## Customizing this skill

This is a bundled default. Want a different house style, a cover page with a
logo, or a different converter? Copy this file to
`.agents/skills/<your-name>/SKILL.md` (use a **different** `name`; bundled skills
win name collisions) and edit it there.

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
  markdown; only style via `#set` / `#show` rules in the wrapper (and the optional
  raw-typst rich elements).
- **Don't** build a `package.json` / `node_modules` / a render script under
  `workspace/`. The compiler installs at the agent root via `bun add`; the render
  script is bundled with the plugin (at
  `/agent/node_modules/typeclaw/src/bundled-plugins/doc-render/render.ts`).
- **Don't** attach a PDF to a GitHub channel — that adapter rejects attachments.
  Link or inline instead.
