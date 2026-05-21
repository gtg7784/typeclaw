import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'
import Image from 'next/image'

import icon from './icon.png'

export const baseOptions: BaseLayoutProps = {
  nav: {
    title: (
      <span className="flex items-center gap-2 text-sm font-semibold tracking-tight">
        <Image src={icon} alt="TypeClaw" width={24} height={24} className="rounded-md" priority />
        TypeClaw
      </span>
    ),
  },
  githubUrl: 'https://github.com/typeclaw/typeclaw',
}
