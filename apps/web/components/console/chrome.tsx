'use client'

import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'
import { ConsoleTop, Notice } from './ui'
import * as sampleData from '@/lib/ari/sample'

/**
 * The strip above every screen: where you are, and the fact that the rows below are a fixture
 * rather than a deployment. The notice is here rather than on each page so it cannot be forgotten
 * by whoever adds the eleventh screen.
 */
export function ConsoleChrome({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname()
  const crumb = pathname.split('/').filter(Boolean).pop()?.toUpperCase() ?? 'CONSOLE'
  return (
    <>
      <ConsoleTop crumb={crumb} />
      <Notice text={sampleData.DEMO_BANNER.toUpperCase()} />
      {children}
    </>
  )
}
