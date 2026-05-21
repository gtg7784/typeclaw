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

const SITE_TITLE = 'TypeClaw — A TypeScript-native agent runtime'
const SITE_DESCRIPTION =
  'TypeScript-native, Bun-powered, Docker-friendly general-purpose agent runtime. Sandboxed by default, plugins as plain TS modules, self-improving via memory.'

export const metadata: Metadata = {
  metadataBase: new URL('https://typeclaw.dev'),
  title: {
    default: SITE_TITLE,
    template: '%s · TypeClaw',
  },
  description: SITE_DESCRIPTION,
  openGraph: {
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    url: 'https://typeclaw.dev',
    siteName: 'TypeClaw',
    type: 'website',
    images: [{ url: '/typeclaw.png', width: 1024, height: 1024, alt: 'TypeClaw mascot' }],
  },
  twitter: {
    card: 'summary',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: ['/typeclaw.png'],
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable} flex min-h-screen flex-col antialiased`}>
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  )
}
