import type { ReactNode } from 'react'
import { Rail } from '@/components/console/ui'
import { ConsoleChrome } from '@/components/console/chrome'

export const metadata = { title: 'ARI console', robots: { index: false } }

/**
 * The console shell. The rail is a client component because it marks the current section, and
 * `usePathname` is the Next way to do that; the header strip is the same reason. What is left
 * here is the grid.
 */
export default function ConsoleLayout({ children }: { readonly children: ReactNode }) {
  return (
    <div className="console-shell">
      <Rail />
      <div style={{ minWidth: 0 }}>
        <ConsoleChrome>{children}</ConsoleChrome>
      </div>
    </div>
  )
}
