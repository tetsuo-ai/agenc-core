/**
 * Local-jsx command onDone routing for the TUI dispatcher. Extracted
 * here (instead of inlined in registry.ts) so it can be unit-tested
 * without dragging the registry's heavy import graph into the test
 * surface. See registry-on-done.test.ts for the contract under test.
 */

export interface LegacyOnDoneTuiHandlers {
  unmountJsx(): void;
  notifyResult?(text: string, opts?: { display?: string }): void;
}

/**
 * Build the onDone callback the local-jsx dispatcher hands to
 * `command.call(onDone, ctx, args)`.
 *
 * Contract:
 *   - When the command calls `onDone("...result text...")` AND the TUI
 *     supplied a `notifyResult` handler, we invoke notifyResult and
 *     RETURN. We do NOT also call unmountJsx, because notifyResult's
 *     own setToolJSX(<Box>) replaces any prior mounted JSX. Calling
 *     unmountJsx in the same React tick would batch-collapse the pair
 *     to setToolJSX(null) and the user would never see the result.
 *   - When the command calls `onDone()` (no result text) OR notifyResult
 *     is unavailable / throws, fall back to the unconditional unmountJsx().
 *   - All handler calls are wrapped in try/catch so a misbehaving TUI
 *     handler can't break the dispatch loop.
 */
export function buildLegacyOnDone(
  tuiHandlers: LegacyOnDoneTuiHandlers,
): (result?: string, opts?: unknown) => void {
  return (result?: string, opts?: unknown) => {
    const surfacedResult =
      typeof result === "string" &&
      result.length > 0 &&
      typeof tuiHandlers.notifyResult === "function";
    if (surfacedResult) {
      try {
        const display =
          opts !== null &&
          typeof opts === "object" &&
          typeof (opts as { display?: unknown }).display === "string"
            ? ((opts as { display: string }).display)
            : undefined;
        tuiHandlers.notifyResult!(
          result as string,
          display !== undefined ? { display } : undefined,
        );
        return;
      } catch {
        // fall through to the unconditional unmount below
      }
    }
    try {
      tuiHandlers.unmountJsx();
    } catch {
      // best-effort cleanup
    }
  };
}
