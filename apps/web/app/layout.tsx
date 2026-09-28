import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import './globals.css'
import { ThemeProvider } from '@/components/theme-provider'

export const metadata: Metadata = {
  // The category line is the one a stranger can verify against the code: an agent gets the
  // ability to *request*, and never a key. "Financial control for autonomous agents" stays as
  // the large type on the page, where it is a claim about the product rather than about the
  // mechanism.
  title: 'ARI. Permission layer between an agent and a wallet',
  description: 'Give an agent the ability to request a payment without giving it a key. Ari evaluates policy, records the decision, and only then lets a signer see a single-use ticket.',
    icons: {
    icon: [
      {
        url: '/icon-light-32x32.png',
        media: '(prefers-color-scheme: light)',
      },
      {
        url: '/icon-dark-32x32.png',
        media: '(prefers-color-scheme: dark)',
      },
      {
        url: '/icon.svg',
        type: 'image/svg+xml',
      },
    ],
    apple: '/apple-icon.png',
  },
}

export const viewport: Viewport = {
  // Without `width`, Next emits no device-width meta and phones render this page as a
  // ~750px desktop layout zoomed to fit — measured on 2026-09-28: a 390px viewport reported a
  // 753px layout width. Every "it looks funny on mobile" symptom traces back to this line.
  // No `maximum-scale`: pinning the scale would stop the layout jumping, and stop zooming too.
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: 'white' },
    { media: '(prefers-color-scheme: dark)', color: 'black' },
  ],
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <ThemeProvider>{children}</ThemeProvider>
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
