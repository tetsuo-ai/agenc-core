/**
 * Semver comparison utilities that use Bun.semver when available
 * and fall back to the npm `semver` package in Node.js environments.
 *
 * Bun.semver.order() is ~20x faster than npm semver comparisons.
 * The npm semver fallback always uses { loose: true }.
 */

import compareSemver from 'semver/functions/compare.js'
import gtSemver from 'semver/functions/gt.js'
import gteSemver from 'semver/functions/gte.js'
import ltSemver from 'semver/functions/lt.js'
import lteSemver from 'semver/functions/lte.js'
import satisfiesSemver from 'semver/functions/satisfies.js'

export function gt(a: string, b: string): boolean {
  if (typeof Bun !== 'undefined') {
    return Bun.semver.order(a, b) === 1
  }
  return gtSemver(a, b, { loose: true })
}

export function gte(a: string, b: string): boolean {
  if (typeof Bun !== 'undefined') {
    return Bun.semver.order(a, b) >= 0
  }
  return gteSemver(a, b, { loose: true })
}

export function lt(a: string, b: string): boolean {
  if (typeof Bun !== 'undefined') {
    return Bun.semver.order(a, b) === -1
  }
  return ltSemver(a, b, { loose: true })
}

export function lte(a: string, b: string): boolean {
  if (typeof Bun !== 'undefined') {
    return Bun.semver.order(a, b) <= 0
  }
  return lteSemver(a, b, { loose: true })
}

export function satisfies(version: string, range: string): boolean {
  if (typeof Bun !== 'undefined') {
    return Bun.semver.satisfies(version, range)
  }
  return satisfiesSemver(version, range, { loose: true })
}

export function order(a: string, b: string): -1 | 0 | 1 {
  if (typeof Bun !== 'undefined') {
    return Bun.semver.order(a, b)
  }
  return compareSemver(a, b, { loose: true })
}
