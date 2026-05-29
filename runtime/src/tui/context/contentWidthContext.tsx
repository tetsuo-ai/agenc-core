import React, { createContext, useContext } from 'react'

const ContentWidthContext = createContext<number | null>(null)

function normalizeWidth(width: number | null | undefined): number | null {
  if (typeof width !== 'number' || !Number.isFinite(width)) {
    return null
  }
  return Math.max(1, Math.floor(width))
}

export function useContentWidth(): number | null {
  return useContext(ContentWidthContext)
}

export function ContentWidthProvider({
  children,
  width,
}: {
  readonly children: React.ReactNode
  readonly width: number | null | undefined
}): React.ReactNode {
  return (
    <ContentWidthContext.Provider value={normalizeWidth(width)}>
      {children}
    </ContentWidthContext.Provider>
  )
}

export function insetContentWidth(
  width: number | null | undefined,
  inset: number,
): number | null {
  const normalized = normalizeWidth(width)
  if (normalized === null) {
    return null
  }
  return Math.max(1, normalized - Math.max(0, Math.floor(inset)))
}
