import React, { createContext, useContext, useMemo } from 'react'
import { type Theme, theme as agencTheme } from '../theme.js'

type ThemeContextValue = {
  /**
   * The active AgenC theme. Always the cyberpunk brand palette in
   * production; tests can pass an override via {@link ThemeProvider}'s
   * `value` prop.
   */
  theme: Theme
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: agencTheme,
})

type Props = {
  children: React.ReactNode
  /**
   * Override the provided theme. Tests use this to substitute a
   * deterministic palette; production code should always omit it so the
   * cyberpunk brand renders consistently.
   */
  value?: Theme
}

/**
 * Provides the AgenC theme to the descendant tree.
 *
 * AgenC ships a single brand palette (cyberpunk; defined in
 * `runtime/src/tui/theme.ts`). There is no light/dark switcher and no
 * system-theme detection — the openclaude theme picker, system theme
 * watcher, and `auto` setting were intentionally dropped during the
 * parity port. ThemeProvider exists to give downstream widgets a
 * `useTheme()` hook so they can react to test overrides without each
 * importing `theme` directly.
 */
export function ThemeProvider({ children, value }: Props) {
  const ctx = useMemo<ThemeContextValue>(
    () => ({ theme: value ?? agencTheme }),
    [value],
  )
  return <ThemeContext.Provider value={ctx}>{children}</ThemeContext.Provider>
}

/**
 * Returns the active AgenC theme. Safe to call outside a provider —
 * falls back to the module-level `theme` export.
 */
export function useTheme(): Theme {
  return useContext(ThemeContext).theme
}
