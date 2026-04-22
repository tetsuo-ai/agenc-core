// @ts-nocheck
import { AsyncLocalStorage } from 'async_hooks'
import { cwd as processCwd } from 'process'
import { getCwdState, getOriginalCwd } from '../bootstrap/state.js'

const cwdOverrideStorage = new AsyncLocalStorage<string>()

function normalizeCwdCandidate(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Run a function with an overridden working directory for the current async context.
 * All calls to pwd()/getCwd() within the function (and its async descendants) will
 * return the overridden cwd instead of the global one. This enables concurrent
 * agents to each see their own working directory without affecting each other.
 */
export function runWithCwdOverride<T>(cwd: string, fn: () => T): T {
  return cwdOverrideStorage.run(cwd, fn)
}

/**
 * Get the current working directory
 */
export function pwd(): string {
  return (
    normalizeCwdCandidate(cwdOverrideStorage.getStore()) ??
    normalizeCwdCandidate(getCwdState()) ??
    processCwd()
  )
}

/**
 * Get the current working directory or the original working directory if the current one is not available
 */
export function getCwd(): string {
  try {
    return pwd()
  } catch {
    return normalizeCwdCandidate(getOriginalCwd()) ?? processCwd()
  }
}
