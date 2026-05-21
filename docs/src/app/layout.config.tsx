import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'

export const baseOptions: BaseLayoutProps = {
  nav: {
    title: (
      <span className="font-mono text-sm font-semibold tracking-tight">
        <span aria-hidden className="mr-1.5">
          🐾
        </span>
        TypeClaw
      </span>
    ),
  },
  githubUrl: 'https://github.com/typeclaw/typeclaw',
}
