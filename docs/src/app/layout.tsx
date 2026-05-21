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

export const metadata: Metadata = {
  metadataBase: new URL('https://typeclaw.dev'),
  title: {
    default: 'TypeClaw — A TypeScript-native agent runtime',
    template: '%s · TypeClaw',
  },
  description:
    'TypeScript-native, Bun-powered, Docker-friendly general-purpose agent runtime. Sandboxed by default, plugins as plain TS modules, self-improving via memory.',
  openGraph: {
    title: 'TypeClaw — A TypeScript-native agent runtime',
    description:
      'TypeScript-native, Bun-powered, Docker-friendly general-purpose agent runtime. Sandboxed by default, plugins as plain TS modules, self-improving via memory.',
    url: 'https://typeclaw.dev',
    siteName: 'TypeClaw',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'TypeClaw — A TypeScript-native agent runtime',
    description:
      'TypeScript-native, Bun-powered, Docker-friendly general-purpose agent runtime. Sandboxed by default, plugins as plain TS modules, self-improving via memory.',
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
