/**
 * gaphunt3 #25 regression test — the legacy hook matcher in
 * src/utils/hooks.ts (matchesPattern) compiled an arbitrary, untrusted
 * matcher string as a RegExp and ran `.test()` on it with NO length cap
 * and NO catastrophic-backtracking guard, while the newer engine
 * (hooks/engine/dispatcher.ts) already rejects such matchers via
 * isUnsafeMatcherRegex. A malicious/buggy plugin or untrusted project
 * skill frontmatter could supply a ReDoS matcher like `^(a+)+$`; on a
 * long, agent-controlled matchQuery (e.g. a FileChanged basename) the
 * `.test()` would backtrack catastrophically and freeze the event loop.
 *
 * The fix mirrors the dispatcher guard: matchesPattern now rejects
 * over-long matchers and nested-quantifier patterns BEFORE compiling the
 * regex, returning false immediately.
 *
 * These are fast unit tests against the exported matcher — no network, no
 * child processes. The ReDoS test fails if the guard is reverted: the
 * unguarded synchronous `.test()` would block the worker (it does not
 * return within seconds), so the elapsed-time assertion never passes and
 * vitest kills the run on testTimeout.
 */
import { describe, it, expect } from 'vitest'

import { matchesPattern } from 'src/utils/hooks'

describe('gaphunt3 #25: matchesPattern ReDoS guard', () => {
  it('rejects a nested-quantifier matcher without catastrophic backtracking', () => {
    // `^(a+)+$` against a long run of `a` that fails the `$` anchor is the
    // canonical ReDoS input. Without the guard this synchronous .test()
    // backtracks exponentially and does not return for many seconds.
    const evilMatcher = '^(a+)+$'
    const longQuery = 'a'.repeat(40) + '!'

    const start = performance.now()
    const result = matchesPattern(longQuery, evilMatcher)
    const elapsedMs = performance.now() - start

    // Guard short-circuits to false (unsafe matcher never matches).
    expect(result).toBe(false)
    // Must return effectively instantly; pre-fix this would not finish.
    expect(elapsedMs).toBeLessThan(50)
  })

  it('rejects other classic catastrophic-backtracking matchers', () => {
    // All flagged by the nested-quantifier heuristic the fix applies.
    for (const evil of ['(a*)*', '(.+)+', '(a+)*', '(ab+)+']) {
      const start = performance.now()
      const result = matchesPattern('a'.repeat(40) + '!', evil)
      const elapsedMs = performance.now() - start
      expect(result).toBe(false)
      expect(elapsedMs).toBeLessThan(50)
    }
  })

  it('rejects matchers longer than the 512-char length cap', () => {
    // Anchored regex (contains metachars) so it bypasses the simple-string
    // fast path and reaches the regex branch. The body is a literal run of
    // `a`, so WITHOUT the length-cap guard `new RegExp(overlong).test(query)`
    // would compile and return true; the guard rejects it (-> false) purely
    // on length. This makes the assertion revert-sensitive.
    const query = 'a'.repeat(520)
    const overlong = `^(${query})$`
    expect(overlong.length).toBeGreaterThan(512)
    expect(matchesPattern(query, overlong)).toBe(false)
  })

  it('still matches legitimate simple, pipe, and regex matchers', () => {
    // Simple-string fast path (unaffected by the guard).
    expect(matchesPattern('Write', 'Write')).toBe(true)
    expect(matchesPattern('Edit', 'Write|Edit')).toBe(true)
    // `*` wildcard.
    expect(matchesPattern('anything', '*')).toBe(true)
    // Ordinary, safe regex matchers must keep working (not flagged unsafe).
    expect(matchesPattern('Write', '^Write.*')).toBe(true)
    expect(matchesPattern('Edit', '^(Write|Edit)$')).toBe(true)
    expect(matchesPattern('Bash', '^Bash$')).toBe(true)
    expect(matchesPattern('Read', '^(Write|Edit)$')).toBe(false)
  })
})
