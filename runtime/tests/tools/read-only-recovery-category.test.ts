import { describe, expect, it } from "vitest";

import { WebFetchTool } from "./WebFetchTool/WebFetchTool.js";
import { WebSearchTool } from "./WebSearchTool/WebSearchTool.js";

/**
 * Regression: resolveToolRecoveryCategory defaults undeclared tools to
 * `side-effecting` — it receives isReadOnly as `_isReadOnly` and discards it.
 * WebFetch and WebSearch declared isReadOnly() === true but no category, so
 * every fetch was recorded side-effecting. When one failed with an unknown
 * outcome it poisoned the session, and assertNoLiveUnknownEffect then blocked
 * all side-effecting and interactive dispatch for the rest of the run.
 *
 * Observed twice in one afternoon on a live hardware-debugging session: after
 * a failed web_fetch the agent could no longer flash the board, and reported
 * itself "blocked mid-debug by a stuck tool lock (a prior web fetch never
 * cleared)".
 */
describe("read-only web tools declare an idempotent recovery category", () => {
  it("WebFetch is idempotent, so a failed fetch cannot poison the session", () => {
    expect(WebFetchTool.isReadOnly()).toBe(true);
    expect(
      (WebFetchTool as { recoveryCategory?: string }).recoveryCategory,
    ).toBe("idempotent");
  });

  it("WebSearch is idempotent for the same reason", () => {
    expect(WebSearchTool.isReadOnly()).toBe(true);
    expect(
      (WebSearchTool as { recoveryCategory?: string }).recoveryCategory,
    ).toBe("idempotent");
  });
});
