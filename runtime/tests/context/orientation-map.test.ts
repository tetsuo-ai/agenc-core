import { describe, expect, it } from 'vitest'

import {
  buildOrientationMap,
  extractTags,
  isExcludedPath,
  ORIENTATION_LAM,
  ORIENTATION_MU,
} from 'src/context/orientation-map.js'

// The ephemeral orientation map ports a SWE-bench-Lite-validated algorithm
// (a structural map improves file localization over naive lexical retrieval).
// These mirror the Python reproduction's sanity checks: the behaviours that
// would silently regress if the graph / scoring / extraction broke.

describe('extractTags', () => {
  it('extracts definitions across languages and filters stopwords from refs', () => {
    const ts = extractTags('export function computeLayout() { return widgetSize() }')
    expect(ts.defs.has('computeLayout')).toBe(true)
    expect(ts.refs.has('widgetSize')).toBe(true)

    const py = extractTags('class Foo:\n    def bar(self):\n        return baz()\n')
    expect(py.defs.has('Foo')).toBe(true)
    expect(py.defs.has('bar')).toBe(true)
    expect(py.refs.has('baz')).toBe(true)
    expect(py.refs.has('self')).toBe(false) // stopword filtered

    const rust = extractTags('pub fn render_frame() {}\nstruct Widget {}')
    expect(rust.defs.has('render_frame')).toBe(true)
    expect(rust.defs.has('Widget')).toBe(true)
  })
})

describe('isExcludedPath', () => {
  it('skips generated/vendored/build dirs', () => {
    expect(isExcludedPath('node_modules/x/index.js')).toBe(true)
    expect(isExcludedPath('target/debug/foo.rs')).toBe(true)
    expect(isExcludedPath('pkg/_x.egg-info/top.py')).toBe(true)
    expect(isExcludedPath('src/real.ts')).toBe(false)
  })
})

describe('buildOrientationMap', () => {
  it('ranks the file that defines an explicitly-quoted issue symbol first', () => {
    const files = new Map<string, string>([
      ['core/engine.ts', 'export function computeLayout() { return widgetSize() }'],
      ['ui/widget.ts', 'export function widgetSize() { return 42 }'],
      ['misc/unrelated.ts', 'export function helper() { return 0 }'],
    ])
    const { ranked } = buildOrientationMap(
      files,
      'The `computeLayout` function returns the wrong value when the window resizes.',
    )
    expect(ranked[0]).toBe('core/engine.ts')
  })

  it('excludes generated dirs from the ranking', () => {
    const files = new Map<string, string>([
      ['src/real.ts', 'export function real() { return 1 }'],
      ['build/lib/copy.ts', 'export function real() { return 1 }'],
    ])
    const { ranked } = buildOrientationMap(files, 'real')
    expect(ranked).toContain('src/real.ts')
    expect(ranked).not.toContain('build/lib/copy.ts')
  })

  it('ego boost surfaces a lexically-invisible structural neighbour (revert-sensitive)', () => {
    // The issue lexically matches the caller (handleRequest); the fix lives in
    // the callee (deepSanitize) which shares NO query term and whose path sorts
    // last — so only the 1-hop ego boost can lift it above the unrelated files.
    const files = new Map<string, string>([
      ['app/handler.ts', 'export function handleRequest(req) { return deepSanitize(req) }'],
      ['zzz/cleaner.ts', 'export function deepSanitize(x) { return x.trim() }'],
      ['aaa/one.ts', 'export function alpha() { return 1 }'],
      ['bbb/two.ts', 'export function beta() { return 2 }'],
      ['ccc/three.ts', 'export function gamma() { return 3 }'],
    ])
    const issue = 'handleRequest crashes on malformed payload'
    const withBoost = buildOrientationMap(files, issue, { mu: 0 }).ranked
    const noBoost = buildOrientationMap(files, issue, { lam: 0, mu: 0 }).ranked
    // With the boost the neighbour jumps to rank 2 (just below the caller);
    // without it the neighbour is buried last. Strictly better → the test fails
    // if the ego boost is removed.
    expect(withBoost.indexOf('zzz/cleaner.ts')).toBeLessThan(
      noBoost.indexOf('zzz/cleaner.ts'),
    )
    expect(withBoost[1]).toBe('zzz/cleaner.ts')
  })

  it('is ephemeral and pure: same inputs → identical ranking', () => {
    const files = new Map<string, string>([
      ['a.ts', 'export function alpha() { return beta() }'],
      ['b.ts', 'export function beta() { return 1 }'],
    ])
    const r1 = buildOrientationMap(files, 'beta').ranked
    const r2 = buildOrientationMap(files, 'beta').ranked
    expect(r1).toEqual(r2)
  })

  it('renders a token-budgeted structural map', () => {
    const files = new Map<string, string>([
      ['core/a.ts', 'export function aaa() {}\nexport function bbb() {}'],
      ['core/b.ts', 'export class Ccc {}'],
    ])
    const { render } = buildOrientationMap(files, 'aaa')
    const small = render(5) // tiny budget → at most a couple lines
    const big = render(1000)
    expect(big.length).toBeGreaterThanOrEqual(small.length)
    expect(big).toContain('core/a.ts')
    expect(big).toContain('aaa')
  })

  it('handles an empty / all-excluded file set without throwing', () => {
    expect(buildOrientationMap(new Map(), 'x').ranked).toEqual([])
    const onlyExcluded = new Map<string, string>([
      ['node_modules/x.js', 'function z() {}'],
    ])
    expect(buildOrientationMap(onlyExcluded, 'z').ranked).toEqual([])
  })

  it('exposes the locked blend constants', () => {
    expect(ORIENTATION_LAM).toBeGreaterThan(0)
    expect(ORIENTATION_MU).toBeGreaterThan(0)
  })
})
