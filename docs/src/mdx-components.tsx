import { Accordion, Accordions } from 'fumadocs-ui/components/accordion'
import { CodeBlock, Pre } from 'fumadocs-ui/components/codeblock'
import { Step, Steps } from 'fumadocs-ui/components/steps'
import { Tab, Tabs } from 'fumadocs-ui/components/tabs'
import defaultMdxComponents from 'fumadocs-ui/mdx'
import type { MDXComponents } from 'mdx/types'

import { Mermaid } from '@/components/mdx/mermaid'

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    Accordion,
    Accordions,
    Mermaid,
    Step,
    Steps,
    Tab,
    Tabs,
    pre: ({ ref: _, ...props }) => (
      <CodeBlock {...props}>
        <Pre>{props.children}</Pre>
      </CodeBlock>
    ),
    ...components,
  }
}

export const useMDXComponents = getMDXComponents
