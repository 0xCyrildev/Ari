'use client'

import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'
import { ConsoleTop } from './ui'
import { ConnectPanel } from './connect'
import { useConsole } from '@/lib/ari/console'

/**
 * The strip above every screen: where you are, and whether the rows below come from a
 * deployment. That second half is here rather than on each page so it cannot be forgotten by
 * whoever adds the eleventh screen, and it is *below* the connection strip rather than beside
 * it because the strip is the only thing that can change the answer.
 */
export function ConsoleChrome({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname()
  const crumb = pathname.split('/').filter(Boolean).pop()?.toUpperCase() ?? 'CONSOLE'
  return (
    <>
      <ConsoleTop crumb={crumb} />
      <ConnectPanel />
      {children}
    </>
  )
}
