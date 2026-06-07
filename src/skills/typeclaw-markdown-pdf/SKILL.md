---
name: typeclaw-markdown-pdf
description: "Turn any Markdown into a polished, professional PDF and (optionally) attach it to a channel. Load this whenever you need to deliver a document as a PDF rather than raw markdown — reports, summaries, briefs, meeting notes, docs, anything a human would want to download, print, or forward. Triggers: 'make a PDF', 'export to PDF', 'markdown to PDF', 'PDF report', 'attach the report', 'send me a PDF', 'as a PDF', 'turn this into a document', a researcher/subagent result you want to ship as a file, 'PDF로', 'PDF로 만들어', 'PDF로 변환', 'PDF 첨부'. Also load before saying you cannot produce PDFs — you can: this skill installs a tiny Typst toolchain into workspace/ on first use, then renders. Covers the one-time setup, the styled wrapper, the render command, and how to attach the PDF to Slack/Discord/Telegram/KakaoTalk. For operating on EXISTING PDFs (merge, split, extract text, fill forms), this is not the skill — use pypdf/qpdf instead."
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

## When to use this

- A research report, brief, or summary the user wants as a downloadable file.
- A subagent (e.g. the `researcher`) handed you a `research-<slug>.md` to ship as a PDF.
- Any channel message asking for "a PDF" / "the report attached" / "PDF로 보내줘".

When plain markdown in chat is fine, **don't** make a PDF. This is for when a
_file_ is the deliverable.

## Step 0 — one-time setup (install the toolchain)

Run this `bash` block once per container life. It is **idempotent** — if the
tools are already present it does nothing and exits fast. It `bun add`s the Typst
compiler (npm pulls only this platform's prebuilt binary — Linux x64/arm64,
glibc or musl) and vendors the SHA256-verified `cmarker` package into
`workspace/.tools/` so `@preview/cmarker` resolves offline.

```sh
set -eu
cd workspace
mkdir -p .tools
cd .tools

CMARKER_VERSION="0.1.8"
PKGDIR="typst-packages/preview/cmarker/$CMARKER_VERSION"

if [ -f "node_modules/@myriaddreamin/typst-ts-node-compiler/package.json" ] && [ -f "$PKGDIR/lib.typ" ]; then
  echo "markdown-pdf toolchain already installed"
else
  # The Typst compiler. `bun add` resolves the right prebuilt NAPI binary for
  # this platform via optionalDependencies — no Rust toolchain, no manual download.
  [ -f package.json ] || echo '{"name":"typeclaw-markdown-pdf-tools","private":true}' > package.json
  bun add @myriaddreamin/typst-ts-node-compiler

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
- The compiler ships Typst **0.14.2**; `cmarker` is pinned + SHA256-verified.

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

- `read("report.md")` is **relative to the workspace** (the compiler's `workspace`
  is set to `workspace/` — see Step 3). Keep the `.typ` and `.md` in `workspace/`.
- Fonts `Libertinus Serif` / `New Computer Modern` are bundled with Typst (no font
  install). For Korean/CJK body text, add `"Noto Serif CJK KR"` to the `font:` list
  and pass that font dir to `fontPaths` in Step 3 (the container's `cjkFonts` toggle
  installs `fonts-noto-cjk` under `/usr/share/fonts`).

## Step 3 — render

`write` this tiny renderer to `workspace/.tools/render.ts`, then run it. It loads
the npm-installed compiler, points the package cache at the vendored `cmarker`, and
writes the PDF. Pass the wrapper and output paths as arguments.

```ts
// workspace/.tools/render.ts
import { NodeCompiler } from '@myriaddreamin/typst-ts-node-compiler'
import { writeFileSync } from 'node:fs'

const [, , mainFile, outFile] = process.argv
if (!mainFile || !outFile) throw new Error('usage: render.ts <main.typ> <out.pdf>')

const compiler = NodeCompiler.create({
  workspace: '.', // run from workspace/, so read("report.md") resolves
  // Add CJK / extra font dirs here if needed:
  // fontArgs: [{ fontPaths: ["/usr/share/fonts"] }],
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
