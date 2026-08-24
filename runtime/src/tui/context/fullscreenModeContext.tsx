import React, { createContext, useContext } from 'react'

const FullscreenModeContext = createContext(false)

export function FullscreenModeProvider({
  enabled,
  children,
}: {
  readonly enabled: boolean
  readonly children: React.ReactNode
}): React.ReactElement {
  return (
    <FullscreenModeContext.Provider value={enabled}>
      {children}
    </FullscreenModeContext.Provider>
  )
}

export function useFullscreenMode(): boolean {
  return useContext(FullscreenModeContext)
}
