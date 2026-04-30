/**
 * `bun:bundle` feature-flag stub.
 *
 * Aliased by both `tsconfig.json` and `vitest.config.ts` so runtime source
 * can write `feature('FLAG_NAME')` without pulling in the real bundler
 * plugin. At test-time every flag resolves to `false`, which is the
 * safe-default for every call site (they all guard experimental branches
 * behind these predicates).
 *
 * Tests that need a flag turned on use `vi.mock('bun:bundle', ...)` to
 * override this stub, matching the existing pattern in
 * the row-level contract tests.
 */
export function feature(_flag: string): boolean {
  return false;
}
