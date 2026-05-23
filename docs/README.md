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
│   ├── meta.json         # top-level sidebar order
│   ├── index.mdx
│   ├── guides/           # narrative, follow-along, has an ending
│   │   ├── meta.json
│   │   ├── getting-started.mdx
│   │   ├── first-channel.mdx
│   │   ├── first-cron.mdx
│   │   ├── first-tunnel.mdx
│   │   ├── teach-the-agent.mdx
│   │   ├── write-a-plugin.mdx
│   │   ├── lock-down-a-public-channel.mdx
│   │   └── deploy.mdx
│   ├── concepts/         # mental models; ~300-600 words each, no commands
│   │   ├── meta.json
│   │   ├── architecture.mdx
│   │   ├── permissions-model.mdx
│   │   ├── memory-loop.mdx
│   │   ├── secrets-policy.mdx
│   │   ├── plugins-and-stages.mdx
│   │   └── managed-files.mdx
│   └── reference/        # schemas, flags, grammars, random-access
│       ├── meta.json
│       ├── typeclaw-json.mdx
│       ├── cron-json.mdx
│       ├── secrets-json.mdx
│       ├── cli.mdx
│       ├── match-rule-dsl.mdx
│       ├── permissions.mdx
│       ├── channel-adapters.mdx
│       ├── tunnel-providers.mdx
│       ├── plugin-api.mdx
│       ├── bundled-plugins.mdx
│       ├── stream-targets.mdx
│       └── env-vars.mdx
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

1. Pick the section. **Guides** for narrative walk-throughs with a finish line; **Concepts** for ~300-600 word mental-model pages with no commands; **Reference** for tables, schemas, and grammars.

2. Drop an MDX file in `content/docs/<section>/`, with a frontmatter block:

   ```mdx
   ---
   title: My Page
   description: One-line summary that shows in the search index
   icon: BookOpen
   ---
   ```

   The `icon` is any [Lucide](https://lucide.dev/) icon name.

3. Add the slug to `content/docs/<section>/meta.json` to control sidebar order.

4. `bun run dev` picks it up automatically.

### Section conventions

- **Guides** end with a forward-link to the next guide. Voice: senior engineer walking through it once. No checklists, no "you should now be able to."
- **Concepts** open with "why this exists / what it solves," then describe the model. No commands, no schemas. Link out to guides and reference.
- **Reference** pages have minimal prose. Tables, schemas, grammars. One-line cross-links to concepts where the "why" lives.

## Pre-commit

This folder uses the same `oxlint` + `oxfmt` setup as the parent repo:

```sh
bun run lint
bun run format
```

The parent repo's `bun run typecheck` does not include the docs site (it has its own `tsconfig.json`); run `bun run build` to typecheck the docs alongside the Next.js build.
