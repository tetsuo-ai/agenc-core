import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { getToolResultsDir } from "../../src/utils/toolResultStorage.js";
import {
  clearCurrentRuntimeSession,
  setCurrentRuntimeSession,
} from "../../src/session/current-session.js";
import type { Session } from "../../src/session/session.js";
import { createTestConfigStore } from "../fixtures.js";

/**
 * Regression: persistence derived its target from process-global bootstrap
 * identity. In the multi-session daemon that names the daemon's BOOT
 * identity, so offloaded artifacts landed in an orphan store
 * (projects/-home-paul/<bootstrap-uuid>/) that no consumer could associate
 * with the conversation — outside both trusted artifact roots the rollout
 * store's recovery validates. Observed live before the fix; the correct
 * store afterward.
 */
describe("getToolResultsDir session identity", () => {
  const work: string[] = [];
  afterEach(() => {
    clearCurrentRuntimeSession();
    for (const dir of work.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("prefers the ambient session's rollout-store sessionDir", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "agenc-conv-dir-"));
    work.push(sessionDir);
    const session = {
      rolloutStore: { store: { sessionDir } },
    } as unknown as Session;
    setCurrentRuntimeSession(session);
    expect(getToolResultsDir()).toBe(join(sessionDir, "tool-results"));
  });

  test("falls back to the bootstrap globals without an ambient session", () => {
    clearCurrentRuntimeSession();
    const dir = getToolResultsDir();
    expect(dir.endsWith(join("tool-results"))).toBe(true);
    // The fallback derives from process-global identity, never the ambient
    // session (there is none) — it must still return a usable path.
    expect(dir.length).toBeGreaterThan("tool-results".length);
  });

  test("an ambient session without a rollout store uses its canonical home", () => {
    const configStore = createTestConfigStore();
    const session = { services: { configStore } } as unknown as Session;
    setCurrentRuntimeSession(session);
    const dir = getToolResultsDir();
    expect(dir.startsWith(configStore.homeContext.path)).toBe(true);
    expect(dir.endsWith(join("tool-results"))).toBe(true);
  });
});
