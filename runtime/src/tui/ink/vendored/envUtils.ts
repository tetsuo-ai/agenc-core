/**
 * Vendored from openclaude/src/utils/envUtils.ts — minimal subset used by
 * the Ink core. Truthy-env-var check.
 */

export function isEnvTruthy(envVar: string | boolean | undefined): boolean {
  if (envVar === undefined || envVar === null) return false
  if (typeof envVar === 'boolean') return envVar
  const normalized = String(envVar).trim().toLowerCase()
  if (normalized === '') return false
  if (normalized === '0' || normalized === 'false' || normalized === 'no') {
    return false
  }
  return true
}
