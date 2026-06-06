---
name: typeclaw-report-to-pdf
description: "Turn a Markdown report into a polished, professional PDF and (optionally) attach it to a channel. Load this whenever you need to deliver a document as a PDF rather than raw markdown — research reports, summaries, briefs, meeting notes, anything a human would want to download, print, or forward. Triggers: 'make a PDF', 'export to PDF', 'PDF report', 'attach the report', 'send me a PDF', 'as a PDF', 'turn this into a document', a researcher/subagent result you want to ship as a file, 'PDF로', '보고서 PDF', 'PDF로 만들어', 'PDF 첨부'. Also load before saying you cannot produce PDFs — you can: a pinned `typst` binary + the `cmarker` package ship in the container image. Covers the styled wrapper, the offline compile command, where to write the file, and how to attach it to Slack/Discord/Telegram/KakaoTalk."
---

# typeclaw-report-to-pdf

You can produce professional PDFs from Markdown. The container ships a pinned [Typst](https://typst.app) binary (`typst`) plus the [`cmarker`](https://typst.app/universe/package/cmarker/) package, vendored into the Typst package cache so compilation works **offline** — no network, no Pandoc, no LaTeX, no headless browser.

The flow is three steps: **(1)** make sure your content is a Markdown file, **(2)** write a small styled `.typ` wrapper that reads that Markdown, **(3)** run `typst compile`. If a channel asked for the PDF, attach the result with `channel_send`.

You do **not** need to learn Typst's markup. `cmarker` reads your CommonMark (headings, lists, tables, code, blockquotes, footnotes, links, images) and renders it. The wrapper only sets the _styling_ — fonts, margins, headings, page numbers — so the output looks deliberate instead of like default-template "AI slop."

## When to use this

- A research report, brief, or summary that the user wants as a downloadable/printable file.
- A subagent (e.g. the `researcher`) handed you a `research-<slug>.md` and you want to ship a PDF.
- Any channel message asking for "a PDF" / "the report attached" / "PDF로 보내줘".

When the user is fine with plain markdown in chat, **don't** make a PDF. This is for when a _file_ is the deliverable.

## Where files go

Write everything under `workspace/` (or `public/` if a guest needs to read it). Those are the only directories your `bash`, `write`, and `edit` tools can write to. Absolute paths inside the container are `/agent/workspace/...`.

- Input markdown: `workspace/report.md` (or reuse a researcher's `workspace/research-<slug>.md`).
- Wrapper: `workspace/report.typ`.
- Output: `workspace/report.pdf`.

Pick a descriptive slug for real work (`workspace/edge-ai-brief.pdf`), not literally `report.pdf`, so multiple reports don't collide.

## Step 1 — have the markdown ready

If you already have a markdown file (yours or a subagent's), use it as-is. Otherwise `write` your content to `workspace/<slug>.md`. Standard CommonMark plus tables and footnotes all work.

## Step 2 — write the styled wrapper

`write` this to `workspace/<slug>.typ`, changing only the `read("...")` filename to match your markdown. This template is tuned for a clean, professional report; adjust fonts/margins if the user asks, but the defaults are a sensible house style.

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
#set text(font: ("Libertinus Serif", "New Computer Modern"), size: 11pt, lang: "en")
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

- `read("report.md")` is **relative to the `.typ` file**, so keep the wrapper and the markdown in the same directory (`workspace/`).
- `cmarker.render(..., blockquote: quote.with(block: true))` routes markdown `>` blockquotes through Typst's `quote`, which the `#show quote` rule above styles with a left bar.
- Fonts `Libertinus Serif` and `New Computer Modern` are bundled with Typst — no font install needed, and they render Latin text professionally. For Korean/CJK body text, the container's `cjkFonts` toggle (`fonts-noto-cjk`, on by default) provides glyphs; add `"Noto Serif CJK KR"` to the `font:` list if a report is primarily Korean.

## Step 3 — compile

Run this with `bash`:

```sh
cd workspace && typst compile report.typ report.pdf
```

`typst compile <input.typ> <output.pdf>`. The package cache is already pointed at the vendored packages via `TYPST_PACKAGE_CACHE_PATH` / `TYPST_PACKAGE_PATH` in the image, so `@preview/cmarker` resolves without network. If you ever see a "package not found" error, that environment is missing — fall back to `typst compile --package-cache-path /usr/local/share/typst/packages report.typ report.pdf`.

Verify it worked: the command exits `0` and `workspace/report.pdf` exists. If compilation fails, Typst prints the offending line; the usual cause is raw HTML or an exotic markdown extension `cmarker` doesn't support — simplify that part of the markdown and recompile.

## Step 4 — deliver

- **If the user is in a channel and asked for the PDF**, attach it:

  ```
  channel_send(text: "Here's the report.", attachments: [{ path: "/agent/workspace/report.pdf", filename: "Edge-AI-Brief.pdf" }])
  ```

  Use a human-friendly `filename` (it's what the recipient downloads), and an absolute `/agent/workspace/...` path. Slack, Discord, Telegram, and KakaoTalk all upload the file; the GitHub adapter does not support attachments, so for GitHub post a link or paste the markdown instead.

- **If you're replying in a thread**, use `channel_reply` with the same `attachments` shape.

- **If there's no channel** (TUI session), just tell the user the path: `workspace/report.pdf`.

## If you got the markdown from a subagent

The `researcher` subagent writes its report to `workspace/research-<slug>.md` and returns a `<report>` block naming the file. Point the wrapper's `read(...)` at that file (copy it to a shorter name first if you like), compile, and attach. You do the PDF step — the researcher's `bash` is read-only and it only emits markdown by design.

## Customizing this skill

This is a bundled default. If you want a different house style — your own fonts, a cover page, a logo, letterhead — copy this file to `.agents/skills/<your-name>/SKILL.md` (use a **different** `name`; bundled skills win name collisions) and edit the wrapper template there. The mechanism (Typst + cmarker) stays the same; only the `.typ` styling changes.

## Don'ts

- **Don't** hand-write Typst markup for the body. Let `cmarker` render the markdown; only style via `#set` / `#show` rules in the wrapper.
- **Don't** write the `.typ`, `.md`, or `.pdf` outside `workspace/` or `public/` — the sandbox blocks it.
- **Don't** try to `apt install pandoc` / `pip install weasyprint` / download a converter — you can't (bash is sandboxed, often offline), and you don't need to. `typst` is already on `PATH`.
- **Don't** attach a PDF to a GitHub channel — that adapter rejects attachments. Link or inline instead.
