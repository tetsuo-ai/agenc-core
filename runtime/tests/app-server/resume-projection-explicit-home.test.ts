import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assertCanonicalRuntimeSettingsProjection } from "../../src/app-server/agent-lifecycle.js";
import { setCurrentRuntimeSession } from "../../src/session/current-session.js";
import type { Session } from "../../src/session/session.js";

/**
 * Live failure: with several sessions open in the daemon, every resume was
 * refused with "runtime settings projection is unavailable: Ambiguous runtime
 * session: N sessions are bootstrapped in this process and no session is
 * bound to the current async context". The verification resolved the AgenC
 * home through the ambient current-session accessor; it must use the daemon's
 * home explicitly.
 */
describe("resume runtime-settings projection with several live sessions", () => {
  afterEach(() => {
    setCurrentRuntimeSession(null);
  });

  it("opens the project state database with the daemon home, not the ambient session", () => {
    // Two tracked fallback sessions make the ambient accessor ambiguous.
    setCurrentRuntimeSession({ conversationId: "a" } as unknown as Session);
    setCurrentRuntimeSession({ conversationId: "b" } as unknown as Session);
    const home = mkdtempSync(join(tmpdir(), "agenc-resume-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "agenc-resume-cwd-"));
    mkdirSync(join(cwd, ".git"), { recursive: true });

    // No runtime-settings row exists yet, so a working open returns quietly;
    // the old code threw before ever reaching the database.
    expect(() =>
      assertCanonicalRuntimeSettingsProjection(
        cwd,
        "conv-resume-test",
        {} as never,
        home,
      ),
    ).not.toThrow();
  });
});
