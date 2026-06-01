import { renderMermaidSVG } from 'beautiful-mermaid'
import { CodeBlock, Pre } from 'fumadocs-ui/components/codeblock'

export function Mermaid({ chart }: { chart: string }) {
  try {
    const svg = renderMermaidSVG(chart, {
      bg: 'var(--color-fd-background)',
      fg: 'var(--color-fd-foreground)',
      accent: 'var(--color-fd-primary)',
      muted: 'var(--color-fd-muted-foreground)',
      surface: 'var(--color-fd-card)',
      transparent: true,
    })

    return <div className="my-6 flex justify-center [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />
  } catch {
    return (
      <CodeBlock title="Mermaid">
        <Pre>{chart}</Pre>
      </CodeBlock>
    )
  }
}
