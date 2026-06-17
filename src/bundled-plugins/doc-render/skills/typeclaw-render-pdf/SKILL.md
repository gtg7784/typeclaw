---
name: typeclaw-render-pdf
description: "The ONLY supported way to render Markdown into a polished, professional PDF (and optionally attach it to a channel). Load this whenever you need to deliver a document as a PDF rather than raw markdown — reports, summaries, briefs, meeting notes, docs, render report, export document, anything a human would want to download, print, or forward, including a researcher's report file shipped as a Slack/Discord attachment. Triggers: 'make a PDF', 'export to PDF', 'markdown to PDF', 'PDF report', 'render report', 'export document', 'the report', 'attach the report', 'send me a PDF', 'as a PDF', 'turn this into a document', 'make it look good', 'beautiful PDF', 'nicer PDF', a researcher/subagent result you want to ship as a file, 'PDF로', 'PDF로 만들어', 'PDF로 변환', 'PDF 첨부', '리포트', '보고서', '예쁘게'. Provided by the bundled `doc-render` plugin: a small Typst toolchain is installed on first use via `bun add` (no PDF library is baked into the image), a bundled themed report library does the styling, and a bundled render script does the compile. The library ships four polished themes (editorial / modern / report / minimal) so the output looks deliberately designed, not like a default-template export. Handles CJK/Korean/Japanese/Chinese: CJK fonts are opt-in, so if the output has tofu (□□□) boxes it tells you to enable `docker.file.cjkFonts` and restart, then regenerates — it never auto-downloads a font. Also load before saying you cannot produce PDFs — you can. NEVER build a PDF with jsPDF, pdfkit, a canvas text dump, a headless-browser raw-text print, or Python ReportLab — those produce unrendered markdown and broken CJK; this skill is the only correct path. Covers the one-time install, picking a theme, the render command, and how to attach the PDF to Slack/Discord/Telegram/KakaoTalk. For operating on EXISTING PDFs (merge, split, extract text, fill forms), this is not the skill — use pypdf/qpdf instead; doc-render produces documents, it does not read them."
---

# typeclaw-render-pdf

You can produce professional PDFs from Markdown. The bundled `doc-render` plugin
ships two things: a **themed report library** (`lib.typ`) that does all the
styling, and a **render script** that does the compile. The only thing installed
on demand is the [Typst](https://typst.app) compiler — a single npm package the
agent `bun add`s into its own `node_modules` the **first time** you need a PDF,
then reuses. No Pandoc, no LaTeX, no headless browser, no PDF toolchain baked
into the image.

The flow is: **(1)** install the compiler once (`bun add`), **(2)** have your
Markdown ready, **(3)** copy the theme library next to it and write a tiny
4-line wrapper that picks a **theme**, **(4)** run the render script. If a channel
asked for the PDF, attach the result with `channel_send`.

You do **not** write Typst markup or hand-style anything. The library's
`report` template styles every Markdown element — headings, lists, tables, code,
quotes, links, figures — and adds a cover, running header, and page footer. The
[`cmarker`](https://typst.app/universe/package/cmarker/) package converts your
CommonMark to Typst; the theme makes it look designed. **Your only real choice is
which theme fits the document.**

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
- Any channel message asking for "a PDF" / "the report attached" / "예쁘게 PDF로".
- Anyone complaining a previous PDF looked "plain" — switch theme and/or follow
  the design tips below; do not hand-roll a new styling system.

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

The `@0.7.0` pin embeds Typst 0.14.2 and keeps the toolchain reproducible. If you
forget this step, the render script in Step 3 stops with the exact `bun add` line
to run, so you can also just try the render and follow its guidance.

> **Where it goes:** the agent's own `node_modules` — the canonical home for
> executable dependencies, gitignored, not user-facing. Do **not** create a
> `package.json` or `node_modules` under `workspace/` for this; let `bun add`
> manage it at the agent root like any other dependency.

## Step 1 — have the markdown ready

Use an existing markdown file (yours or a subagent's), or `write` your content to
a markdown file. Standard CommonMark plus tables and footnotes all work. Put the
`.md`, the copied `lib.typ`, and the `.typ` wrapper (Step 2) in the **same
directory** so the wrapper's relative `read("...")` and `#import "lib.typ"` both
resolve. Any agent-writable directory works (`workspace/`, `public/`, `mounts/`,
or wherever the source `.md` already lives, e.g. a researcher's report under
`public/`). There is no required directory; keep the three files together and run
the render from there.

## Step 2 — pick a theme and write the wrapper

First, **copy the bundled theme library** next to your markdown (Typst's
workspace sandbox only resolves imports under the render's working directory, so
the library must sit beside the wrapper — an absolute import from outside won't
resolve):

```sh
cd /agent/workspace            # or wherever your .md lives (public/, mounts/, …)
cp /agent/node_modules/typeclaw/src/bundled-plugins/doc-render/templates/lib.typ .
```

Then `write` a tiny `.typ` wrapper next to the markdown. This is the **entire**
wrapper — you do not style anything yourself; the theme does it:

```typst
#import "lib.typ": report, callout, kpi, kpi-row, pullquote
#show: report.with(
  theme: "editorial",                       // editorial | modern | report | minimal
  title: "Edge-AI Quarterly Brief",
  subtitle: "Q2 2026 · Internal Distribution",
  date: "2026-06-17",
  author: "Research",
)
#import "@preview/cmarker:0.1.8"
#cmarker.render(
  read("report.md"),
  h1-level: 1,
  blockquote: quote.with(block: true),
  // makes the helpers available to <!--raw-typst …--> snippets in the markdown
  scope: (callout: callout, kpi: kpi, kpi-row: kpi-row, pullquote: pullquote),
)
```

### Choosing the theme

Pick the one that fits the document's purpose. All four are built on the fonts
that ship in the container, so they render identically everywhere.

- **`editorial`** — magazine look: a dedicated cover page, smallcaps tracked
  headings, booktabs tables, wine accent. The elegant default for prose: reports,
  briefs, memos, articles.
- **`modern`** — startup look: a bold bleed-bar masthead, accent-bar headings,
  airy ragged-right, indigo accent, accent-header tables. Product/launch briefs,
  updates, anything that should feel current.
- **`report`** — data / consulting look: a cover page with a full accent band,
  accent-ruled section heads, strong navy zebra tables, plus `kpi()` and
  `pullquote()` helpers. Boardroom-ready analyses and data reports.
- **`minimal`** — Apple-clean: a spacious title block, large light headings, no
  running header, generous margins, ultra-light tables. Short notes, letters,
  one-pagers.

When unsure, use `editorial`. If a user said the last PDF looked plain, try
`modern` or `report` (the most visibly "designed") and apply the tips below.

### Optional knobs

- `accent: rgb("#0f766e")` — override the theme's accent color (links, rules,
  headings, cover, table headers). Omit or pass `accent: auto` for the theme
  default.
- `cover: "page" | "masthead" | "title" | none` — override the cover treatment
  (`page` = dedicated cover page, `masthead` = bold top block, `title` = compact
  title block), or `none` to drop it (e.g. a short memo). Omit for the theme
  default.
- Omit `title` entirely and no cover is drawn — useful when the markdown already
  opens with its own H1.

## Step 3 — render

The render script is **bundled with the plugin** — you do not write it. It lives
at `/agent/node_modules/typeclaw/src/bundled-plugins/doc-render/render.ts`.

You should already be `cd`'d into the directory holding your `.typ`, `.md`, and
the copied `lib.typ` (from Step 2). The wrapper's `read("report.md")` and
`#import "lib.typ"` both resolve relative to the render's working directory, so
you must run it from there:

```sh
cd /agent/workspace            # or wherever your .typ + .md + lib.typ live
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

## Make it genuinely beautiful (design tips)

A theme gets you 90% of the way. The rest is content discipline — the same things
that separate a designed document from a markdown dump:

- **Front-load structure.** A short lead paragraph under the title, then clear
  `##` sections. Don't open with a wall of text.
- **Tables over repeated bullet stanzas.** If you're repeating the same fields
  per item (name, value, status…), a table reads far better than N bullet lists.
  The theme styles tables with clean rules and a header row.
- **Caption your images** so they read as figures, not floating screenshots:

  ```markdown
  <!--raw-typst
  #figure(image("chart.png", width: 80%), caption: [Revenue trend, Q1–Q2 2026.])
  -->
  ```

  Images default to a sensible max width; keep them to one strong figure per idea
  rather than many raw dumps at random sizes.

- **Use callouts for what matters** — a risk, a key result, a caveat — instead of
  bolding a whole paragraph. `callout` is exported by the library (pass it via
  `scope:` as shown above), then used inside the markdown:

  ```markdown
  <!--raw-typst
  #callout(kind: "warning", title: "Risk")[A single supplier covers 40% of NPUs.]
  #callout(kind: "success")[Revenue grew 31% YoY, ahead of plan.]
  -->
  ```

  Kinds: `note`, `tip`, `success`, `warning`, `danger`. Keep them rare — two or
  three in a document read as deliberate; a wall of colored boxes reads as noise.

- **Lead with the numbers (data reports).** For a metrics-heavy document, open a
  section with a row of KPI cards instead of burying figures in prose. `kpi` and
  `kpi-row` are exported by the library (pass them via `scope:` as shown above):

  ```markdown
  <!--raw-typst
  #kpi-row(
    kpi("$5.5M", "Revenue", sub: "+31% YoY"),
    kpi("124%", "Net retention", sub: "+6pt"),
    kpi("63.4%", "Gross margin", sub: "+240bp"),
  )
  -->
  ```

  Use `pullquote("…", by: "…")` for a centered featured quote between sections.

- **Let whitespace breathe, but don't pad.** Trust the theme's rhythm; don't add
  manual `#v(...)` spacers around everything.

## Handling CJK content

CJK fonts are **opt-in** (the `docker.file.cjkFonts` toggle). The themes already
list `Noto Serif CJK` / `Noto Sans Mono CJK` as fallbacks, so Korean/Japanese/
Chinese resolve automatically **when those fonts are present**. When the toggle
is off, Typst still renders — it just substitutes `.notdef` tofu (□) boxes for
every CJK glyph. **Do not** download, vendor, or `curl` a font to work around
this, and **do not** silently deliver a tofu PDF.

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
  and KakaoTalk upload the file; LINE and the GitHub adapter have no attachment
  support, so there post a link or paste the markdown.

- **Replying in a thread** — use `channel_reply` with the same `attachments` shape.

- **No channel** (TUI session) — just report the path: `report.pdf`.

## If you got the markdown from a subagent

The `researcher` subagent writes its report to `research-<slug>.md` and returns a
`<report>` block naming the file. Copy `lib.typ` into that file's directory, point
the wrapper's `read(...)` at the report, render there, and attach. You do the PDF
step — the researcher's `bash` is read-only and it only emits markdown by design.

## Customizing this skill

This is a bundled default. Want a fifth theme, a cover page with a logo, or a
house style? Two options: (a) copy `lib.typ` into the document directory and edit
your local copy before rendering (one-off), or (b) for a durable change, copy this
file to `.agents/skills/<your-name>/SKILL.md` (use a **different** `name`; bundled
skills win name collisions) and point it at your own theme library.

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

- **Don't** hand-write a styling wrapper. Use `#show: report.with(theme: …)` from
  the bundled library; only reach for raw Typst (via `<!--raw-typst … -->`) for
  the occasional figure or callout.
- **Don't** import `lib.typ` by absolute path — copy it next to the markdown
  first (Typst's workspace sandbox won't resolve an import from outside the
  render's working directory).
- **Don't** build a `package.json` / `node_modules` / a render script under
  `workspace/`. The compiler installs at the agent root via `bun add`; the render
  script and theme library are bundled with the plugin (under
  `/agent/node_modules/typeclaw/src/bundled-plugins/doc-render/`).
- **Don't** attach a PDF to a GitHub channel — that adapter rejects attachments.
  Link or inline instead.
