// typeclaw doc-render — themed report library
// =============================================
// Turns Markdown (rendered via `cmarker`) into a deliberately designed PDF. The
// `report` template styles every element and adds a cover / masthead, running
// header, and footer. Pick a theme; that is the main choice.
//
// FONT CONSTRAINT. The container ships only Typst's bundled text faces
// ("Libertinus Serif", "New Computer Modern") plus the mono "DejaVu Sans Mono".
// Every theme is built on those so output is identical in-container and on a dev
// box. Beauty here comes from composition — type scale, a real cover, tracking,
// rules, restrained color, generous rhythm — not from swapping typefaces. CJK
// families are appended as fallbacks (resolve only when `docker.file.cjkFonts`
// is on; harmless otherwise).
//
// USAGE (wrapper written next to the markdown):
//   #import "lib.typ": report, callout
//   #show: report.with(theme: "editorial", title: "…", subtitle: "…",
//                      date: "…", author: "…")
//   #import "@preview/cmarker:0.1.8"
//   #cmarker.render(read("report.md"), h1-level: 1,
//     blockquote: quote.with(block: true), scope: (callout: callout))

// --- fonts -----------------------------------------------------------------

#let _serif = ("Libertinus Serif", "New Computer Modern", "Noto Serif CJK KR", "Noto Serif CJK JP", "Noto Serif CJK SC")
#let _mono = ("DejaVu Sans Mono", "Noto Sans Mono CJK KR", "Noto Sans Mono CJK JP", "Noto Sans Mono CJK SC")

// --- color derivation (one accent does the work) ---------------------------

#let _muted(spec) = color.mix((spec.ink, 58%), (white, 42%), space: oklab)
#let _hair(spec) = color.mix((spec.ink, 16%), (white, 84%), space: oklab)
#let _tint(spec) = color.mix((spec.accent, 8%), (white, 92%), space: oklab)
#let _link(spec) = color.mix((spec.accent, 78%), (spec.ink, 22%), space: oklab)

// --- theme registry --------------------------------------------------------
// `t*` fields are em-multipliers off `base`, giving each theme an explicit,
// designed type scale. `cover` selects the masthead treatment; `id` drives the
// per-theme heading/table/cover branches below.

#let _themes = (
  editorial: (
    id: "editorial",
    body: _serif,
    base: 11pt,
    tTitle: 3.1,
    tH1: 1.7,
    tH2: 1.22,
    tH3: 1.05,
    accent: rgb("#7b2d3b"),
    ink: rgb("#22202a"),
    justify: true,
    leading: 0.74em,
    spacing: 1.2em,
    margin: (x: 2.7cm, top: 2.7cm, bottom: 2.6cm),
    cover: "page",
    header: true,
  ),
  modern: (
    id: "modern",
    body: _serif,
    base: 11pt,
    tTitle: 2.7,
    tH1: 1.75,
    tH2: 1.25,
    tH3: 1.05,
    accent: rgb("#4f46e5"),
    ink: rgb("#0f172a"),
    justify: false,
    leading: 0.8em,
    spacing: 1.3em,
    margin: (x: 2.4cm, top: 2.4cm, bottom: 2.5cm),
    cover: "masthead",
    header: true,
  ),
  report: (
    id: "report",
    body: _serif,
    base: 10.5pt,
    tTitle: 2.7,
    tH1: 1.45,
    tH2: 1.18,
    tH3: 1.02,
    accent: rgb("#1d4ed8"),
    ink: rgb("#111827"),
    justify: true,
    leading: 0.7em,
    spacing: 1.05em,
    margin: (x: 2.3cm, top: 2.4cm, bottom: 2.3cm),
    cover: "page",
    header: true,
  ),
  minimal: (
    id: "minimal",
    body: _serif,
    base: 11.5pt,
    tTitle: 2.2,
    tH1: 1.5,
    tH2: 1.18,
    tH3: 1.02,
    accent: rgb("#171717"),
    ink: rgb("#1c1c1c"),
    justify: false,
    leading: 0.85em,
    spacing: 1.45em,
    margin: (x: 3.4cm, top: 3.2cm, bottom: 3.2cm),
    cover: "title",
    header: false,
  ),
)

#let _resolve(theme) = {
  if theme not in _themes {
    panic("unknown theme '" + theme + "' — use one of: " + _themes.keys().join(", "))
  }
  _themes.at(theme)
}

#let _eyebrow(spec, body, fill: auto) = text(
  font: _mono,
  size: spec.base * 0.7,
  weight: "medium",
  tracking: 0.16em,
  fill: if fill == auto { _muted(spec) } else { fill },
)[#upper(body)]

#let _meta-line(author, date) = {
  if author != none and date != none { author + " · " + date } else if author != none { author } else if date != none { date } else { "" }
}

// --- public helpers (drop into markdown via <!--raw-typst … -->) ------------

#let callout(kind: "note", title: none, body) = {
  let p = (
    note: (bar: rgb("#3b82f6"), bg: rgb("#eff6ff"), label: "Note"),
    tip: (bar: rgb("#22c55e"), bg: rgb("#f0fdf4"), label: "Tip"),
    success: (bar: rgb("#16a34a"), bg: rgb("#f0fdf4"), label: "Success"),
    warning: (bar: rgb("#f59e0b"), bg: rgb("#fffbeb"), label: "Warning"),
    danger: (bar: rgb("#ef4444"), bg: rgb("#fef2f2"), label: "Caution"),
  ).at(kind, default: (bar: rgb("#3b82f6"), bg: rgb("#eff6ff"), label: "Note"))
  block(width: 100%, fill: p.bg, stroke: (left: 3pt + p.bar), inset: (left: 13pt, rest: 11pt), radius: (right: 4pt), breakable: false)[
    #text(weight: "bold", fill: p.bar.darken(18%))[#if title != none { title } else { p.label }.]
    #h(0.4em)
    #body
  ]
  v(0.6em)
}

#let kpi(value, label, sub: none, accent: rgb("#1d4ed8")) = block(width: 100%, inset: 13pt, stroke: (bottom: 2.5pt + accent, rest: 0.5pt + luma(225)), fill: white)[
  #align(center)[
    #text(size: 1.9em, weight: "bold", fill: accent.darken(15%))[#value]
    #v(0.25em)
    #text(font: _mono, size: 0.62em, weight: "medium", tracking: 0.12em, fill: luma(110))[#upper(label)]
    #if sub != none { v(0.15em); text(size: 0.72em, fill: luma(150))[#sub] }
  ]
]

#let kpi-row(..cards) = {
  let items = cards.pos()
  block(width: 100%, breakable: false, above: 0.9em, below: 0.9em, grid(columns: items.len(), column-gutter: 12pt, ..items))
}

#let pullquote(body, by: none) = {
  v(0.4em)
  block(width: 100%, inset: (x: 8%, y: 0.6em))[
    #align(center)[
      #text(size: 1.35em, style: "italic", fill: luma(60))[#body]
      #if by != none { v(0.5em); text(font: _mono, size: 0.72em, tracking: 0.1em, fill: luma(130))[#upper("— " + by)] }
    ]
  ]
  v(0.4em)
}

// --- cover treatments ------------------------------------------------------

#let _cover-page-editorial(spec, title, subtitle, date, author) = {
  page(margin: (x: spec.margin.x, top: 3cm, bottom: 2.8cm), header: none, footer: none)[
    #set text(font: spec.body, fill: spec.ink)
    #set par(justify: false)
    #_eyebrow(spec, _meta-line(author, date))
    #v(1fr)
    #text(size: spec.base * spec.tTitle, weight: "bold")[#title]
    #if subtitle != none {
      v(0.5em)
      text(size: spec.base * 1.3, style: "italic", fill: _muted(spec))[#subtitle]
    }
    #v(0.8em)
    #line(length: 38%, stroke: 1.4pt + spec.accent)
    #v(1.4fr)
  ]
  pagebreak(weak: true)
}

#let _cover-page-report(spec, title, subtitle, date, author) = {
  page(margin: 0pt, header: none, footer: none)[
    #set text(font: spec.body, fill: spec.ink)
    #set par(justify: false)
    #block(width: 100%, height: 4.5cm, fill: spec.accent, inset: (x: spec.margin.x, top: 2.4cm))[
      #_eyebrow(spec, "Report", fill: white.transparentize(25%))
    ]
    #pad(x: spec.margin.x, top: 1.6cm)[
      #text(size: spec.base * spec.tTitle, weight: "bold")[#title]
      #if subtitle != none {
        v(0.5em)
        text(size: spec.base * 1.25, fill: _muted(spec))[#subtitle]
      }
    ]
    #place(bottom + left, dx: spec.margin.x, dy: -2.4cm, _eyebrow(spec, _meta-line(author, date)))
  ]
  pagebreak(weak: true)
}

#let _masthead-modern(spec, title, subtitle, date, author) = {
  place(top + left, dx: -spec.margin.x, dy: -spec.margin.top, rect(width: 100% + spec.margin.x * 2, height: 6pt, fill: spec.accent))
  v(0.4em)
  set par(justify: false)
  _eyebrow(spec, _meta-line(author, date), fill: spec.accent)
  v(0.5em)
  text(size: spec.base * spec.tTitle, weight: "bold", fill: spec.ink)[#title]
  if subtitle != none {
    v(0.35em)
    text(size: spec.base * 1.2, fill: _muted(spec))[#subtitle]
  }
  v(0.7em)
  line(length: 100%, stroke: 1.5pt + spec.accent)
  v(1.4em)
}

#let _title-minimal(spec, title, subtitle, date, author) = {
  set par(justify: false)
  v(0.5em)
  text(size: spec.base * spec.tTitle, weight: "medium", fill: spec.ink)[#title]
  if subtitle != none {
    v(0.5em)
    text(size: spec.base * 1.15, fill: _muted(spec))[#subtitle]
  }
  let m = _meta-line(author, date)
  if m != "" {
    v(0.9em)
    _eyebrow(spec, m)
  }
  v(2.4em)
}

// --- the report template ---------------------------------------------------

#let report(title: none, subtitle: none, date: none, author: none, theme: "editorial", accent: auto, cover: auto, body) = {
  let spec = _resolve(theme)
  if accent != auto { spec.accent = accent }
  let cover-kind = if cover == auto { spec.cover } else { cover }
  set document(title: if title != none { title } else { "Document" })

  set page(
    paper: "a4",
    margin: spec.margin,
    header: context {
      if spec.header and counter(page).get().first() > 1 {
        block(width: 100%)[
          #_eyebrow(spec, if title != none { title } else { "" }) #h(1fr) #_eyebrow(spec, if author != none { author } else { "" })
          #v(-0.5em)
          #line(length: 100%, stroke: 0.5pt + _hair(spec))
        ]
      }
    },
    footer: context {
      align(center, _eyebrow(spec, [#counter(page).get().first() / #counter(page).final().first()]))
    },
  )

  set text(font: spec.body, size: spec.base, fill: spec.ink, lang: "en")
  set par(justify: spec.justify, leading: spec.leading, spacing: spec.spacing, linebreaks: "optimized")
  show link: it => text(fill: _link(spec), underline(it))

  set heading(numbering: none)
  show heading.where(level: 1): it => {
    if spec.id == "editorial" {
      block(above: 2em, below: 1.55em, width: 100%)[
        #text(size: spec.base * spec.tH1, weight: "bold", tracking: 0.02em)[#smallcaps(it.body)]
        #v(-0.3em)
        #line(length: 100%, stroke: 0.6pt + _hair(spec))
      ]
    } else if spec.id == "modern" {
      block(above: 1.9em, below: 1.5em, width: 100%)[
        #grid(columns: (3.5pt, 1fr), column-gutter: 11pt, rect(width: 3.5pt, height: 0.95em, fill: spec.accent, radius: 1pt), text(size: spec.base * spec.tH1, weight: "bold")[#it.body])
      ]
    } else if spec.id == "report" {
      block(above: 1.7em, below: 1.4em, width: 100%)[
        #text(size: spec.base * spec.tH1, weight: "bold", fill: spec.ink)[#it.body]
        #v(-0.28em)
        #line(length: 100%, stroke: 1.4pt + spec.accent)
      ]
    } else {
      block(above: 2.2em, below: 1.6em)[
        #text(size: spec.base * spec.tH1, weight: "medium", fill: spec.ink)[#it.body]
      ]
    }
  }
  show heading.where(level: 2): it => block(above: 1.85em, below: 1.45em)[
    #if spec.id == "editorial" {
      text(size: spec.base * spec.tH2, weight: "semibold", fill: spec.accent)[#smallcaps(it.body)]
    } else {
      text(size: spec.base * spec.tH2, weight: "semibold", fill: if spec.id == "minimal" { _muted(spec) } else { spec.accent })[#it.body]
    }
  ]
  show heading.where(level: 3): it => block(above: 1.5em, below: 1.15em)[
    #text(size: spec.base * spec.tH3, weight: "semibold", fill: spec.ink)[#it.body]
  ]

  show quote.where(block: true): it => block(width: 100%, inset: (left: 1.1em, y: 0.25em), stroke: (left: 2.5pt + spec.accent.lighten(10%)), text(style: "italic", fill: _muted(spec), it.body))

  show raw.where(block: true): it => block(width: 100%, fill: rgb("#f8fafc"), stroke: 0.5pt + _hair(spec), inset: 9pt, radius: 4pt, breakable: false, text(font: _mono, size: 0.85em, it))
  show raw.where(block: false): it => box(fill: rgb("#f1f5f9"), inset: (x: 3pt), outset: (y: 3pt), radius: 2pt, text(font: _mono, size: 0.88em, it))

  // set/show must stay at the function's top level (a `set` nested in an `if`
  // block only scopes to that block and never reaches `body`).
  let _zebra = spec.id == "modern" or spec.id == "report"
  set table(
    stroke: if _zebra { none } else { (_, y) => (top: if y == 0 { 0.9pt + spec.ink } else { 0pt }, bottom: 0.5pt + _hair(spec)) },
    fill: if _zebra { (_, y) => if y == 0 { spec.accent } else if calc.odd(y) { _tint(spec) } else { white } } else { none },
    inset: if _zebra { (x: 10pt, y: 7pt) } else { (x: 4pt, y: 6pt) },
  )
  show table.cell.where(y: 0): set text(fill: if _zebra { white } else { spec.ink }, weight: "bold")

  show figure.caption: it => text(size: 0.82em, fill: _muted(spec))[#it.supplement #context it.counter.display(it.numbering). #it.body]
  set image(width: 82%)

  if title != none and cover-kind != none {
    if cover-kind == "page" and spec.id == "report" {
      _cover-page-report(spec, title, subtitle, date, author)
    } else if cover-kind == "page" {
      _cover-page-editorial(spec, title, subtitle, date, author)
    } else if cover-kind == "masthead" {
      _masthead-modern(spec, title, subtitle, date, author)
    } else if cover-kind == "title" {
      _title-minimal(spec, title, subtitle, date, author)
    }
  }

  body
}
