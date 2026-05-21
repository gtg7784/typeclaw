# typeclaw.dev

Source for [typeclaw.dev](https://typeclaw.dev) — the TypeClaw landing page and documentation site.

Built with [Next.js 16](https://nextjs.org/), [Fumadocs](https://fumadocs.dev/), and [Tailwind CSS v4](https://tailwindcss.com/). Lives in this folder so doc changes ship in the same PR as the code that motivates them.

## Development

```sh
bun install
bun run dev
```

Opens on [http://localhost:3000](http://localhost:3000).

## Build

```sh
bun run build
bun run start
```

## Layout

```
docs/
├── content/docs/         # MDX pages (auto-routed under /docs)
│   ├── meta.json         # sidebar order
│   ├── index.mdx
│   ├── quickstart.mdx
│   ├── configuration.mdx
│   ├── plugins.mdx
│   ├── channels.mdx
│   ├── memory.mdx
│   ├── secrets.mdx
│   ├── cron.mdx
│   └── tunnels.mdx
├── src/
│   ├── app/
│   │   ├── layout.tsx        # root layout with Geist fonts + Fumadocs provider
│   │   ├── layout.config.tsx # nav title and GitHub link shared by every layout
│   │   ├── page.tsx          # custom landing page
│   │   ├── globals.css       # Tailwind + Fumadocs preset imports
│   │   ├── icon.svg          # favicon (paw emblem)
│   │   ├── api/search/route.ts
│   │   └── docs/
│   │       ├── layout.tsx
│   │       └── [[...slug]]/page.tsx
│   ├── lib/source.ts         # Fumadocs source loader
│   └── mdx-components.tsx    # MDX component overrides
├── public/                   # static assets
├── source.config.ts          # Fumadocs MDX config
├── next.config.ts            # Next.js + Fumadocs MDX plugin
├── postcss.config.mjs        # Tailwind v4 via PostCSS
└── tsconfig.json
```

## Adding a docs page

1. Drop an MDX file in `content/docs/`, with a frontmatter block:

   ```mdx
   ---
   title: My Page
   description: One-line summary that shows in the search index
   icon: BookOpen
   ---
   ```

   The `icon` is any [Lucide](https://lucide.dev/) icon name.

2. Add the slug to `content/docs/meta.json` to control sidebar order (use `"---"` to insert a separator).

3. `bun run dev` picks it up automatically.

## Pre-commit

This folder uses the same `oxlint` + `oxfmt` setup as the parent repo:

```sh
bun run lint
bun run format
```

The parent repo's `bun run typecheck` does not include the docs site (it has its own `tsconfig.json`); run `bun run build` to typecheck the docs alongside the Next.js build.
