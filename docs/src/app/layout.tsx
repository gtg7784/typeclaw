import { RootProvider } from 'fumadocs-ui/provider/next'
import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'

import './globals.css'

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
})

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
})

const SITE_URL = 'https://typeclaw.dev'
const SITE_TITLE = 'TypeClaw — A TypeScript-native agent runtime'
const SITE_DESCRIPTION =
  'TypeScript-native, Bun-powered, Docker-friendly general-purpose agent runtime. Sandboxed by default, plugins as plain TS modules, self-improving via memory.'

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: SITE_TITLE,
    template: '%s · TypeClaw',
  },
  description: SITE_DESCRIPTION,
  applicationName: 'TypeClaw',
  keywords: [
    'TypeClaw',
    'AI agent runtime',
    'TypeScript agent',
    'Bun agent',
    'Docker agent',
    'self-hosted AI agent',
    'agent framework',
    'LLM agent',
    'Slack bot',
    'Discord bot',
    'cron AI agent',
  ],
  authors: [{ name: 'TypeClaw' }],
  creator: 'TypeClaw',
  publisher: 'TypeClaw',
  alternates: {
    canonical: '/',
  },
  openGraph: {
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    url: SITE_URL,
    siteName: 'TypeClaw',
    type: 'website',
    images: [{ url: '/typeclaw.png', width: 1000, height: 1000, alt: 'Typeey, the TypeClaw mascot' }],
  },
  twitter: {
    card: 'summary',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: ['/typeclaw.png'],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
      'max-video-preview': -1,
    },
  },
}

const jsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebSite',
      '@id': `${SITE_URL}/#website`,
      url: SITE_URL,
      name: 'TypeClaw',
      description: SITE_DESCRIPTION,
      publisher: { '@id': `${SITE_URL}/#organization` },
    },
    {
      '@type': 'Organization',
      '@id': `${SITE_URL}/#organization`,
      name: 'TypeClaw',
      url: SITE_URL,
      logo: `${SITE_URL}/typeclaw.png`,
      sameAs: ['https://github.com/typeclaw/typeclaw'],
    },
    {
      '@type': 'SoftwareApplication',
      name: 'TypeClaw',
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Linux, macOS, Windows (via Docker)',
      description: SITE_DESCRIPTION,
      url: SITE_URL,
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    },
  ],
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable} flex min-h-screen flex-col antialiased`}>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  )
}
