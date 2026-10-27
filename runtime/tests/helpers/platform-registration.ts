import { describe, it, type TestFunction, type TestOptions } from "vitest";

/**
 * Register a test only where it can run. Vitest's runIf and skipIf still
 * register a skipped test, and the hermetic release run on Linux requires
 * zero skipped tests, so a test that exists for one platform or volume type
 * must not be registered anywhere else.
 */
export function itWhen(
  condition: boolean,
): (name: string, fn: TestFunction, options?: number | TestOptions) => void {
  return condition
    ? (name, fn, options) => {
        it(name, fn, options);
      }
    : () => {};
}

/** A test of macOS-only behavior: registered on macOS, absent elsewhere. */
export const itOnDarwin = itWhen(process.platform === "darwin");

/** A suite of macOS-only behavior: registered on macOS, absent elsewhere. */
export function describeOnDarwin(name: string, fn: () => void): void {
  if (process.platform === "darwin") describe(name, fn);
}
