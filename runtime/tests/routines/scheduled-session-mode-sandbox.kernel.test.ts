/**
 * The routine shell confinement case needs the real Linux session sandbox
 * (bubblewrap), which the release test boundary image does not have, so it
 * runs in the real-kernel lane. The rest of the scheduled-routine end-to-end
 * tests stay in scheduled-session-mode.e2e.test.ts.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { cleanups, daemon, routineOf } from "./scheduled-session-mode.harness.js";

describe("scheduled routines run with the mode of the session that created them", () => {
  it("confines a Bypass routine's shell to its workspace: no session temp root, TMPDIR in a scratch folder there", async () => {
    const d = await daemon();
    const tempRoot = d.runtimeOptions.sessionTempRoot;
    const escaped = join(tempRoot, `routine-escape-${Date.now()}.txt`);
    cleanups.push(() => rmSync(escaped, { force: true }));
    const routine = routineOf(await d.createFromChat(await d.chat("bypassPermissions")));
    d.steps.push({ exec: `touch ${escaped}` }, { exec: "mktemp" }, { answer: "Done." });
    await d.scheduledRun(routine.id);
    expect(existsSync(escaped)).toBe(false);
    // mktemp made its file in the run's scratch folder inside the workspace.
    expect(d.toolResults.at(-1)).toContain(join(d.workspace, ".agenc-routine"));
    // The scratch folder is gone after the run, and git would have ignored it.
    expect(readdirSync(join(d.workspace, ".agenc-routine"))).toEqual([".gitignore"]);
    expect(readFileSync(join(d.workspace, ".agenc-routine", ".gitignore"), "utf8")).toBe("*\n");
  }, 120_000);
});
