/**
 * Vendored from openclaude/src/utils/semver.ts plus a tiny `coerce` helper
 * — minimal surface used by terminal capability detection. Uses a small
 * inline semver parser so we don't add a runtime dep on the `semver`
 * package.
 */

function parseSemver(
  raw: string,
): { major: number; minor: number; patch: number } | null {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(raw.trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
  }
}

export function gte(a: string, b: string): boolean {
  const av = parseSemver(a)
  const bv = parseSemver(b)
  if (!av || !bv) return false
  if (av.major !== bv.major) return av.major > bv.major
  if (av.minor !== bv.minor) return av.minor > bv.minor
  return av.patch >= bv.patch
}

/**
 * Matches npm semver's `coerce(value)` for the subset the Ink core uses:
 * returns `{ version: string }` when a semver-like prefix can be parsed,
 * otherwise `null`. Accepts leading junk and optional `v` prefix.
 */
export function coerce(
  value: string | undefined | null,
): { version: string } | null {
  if (!value) return null
  const match = /\d+(?:\.\d+){0,2}/.exec(String(value))
  if (!match) return null
  const parsed = parseSemver(match[0])
  if (!parsed) return null
  return { version: `${parsed.major}.${parsed.minor}.${parsed.patch}` }
}
