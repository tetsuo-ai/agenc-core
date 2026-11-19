/**
 * A session whose process died mid-turn resumes with the prefix it sent.
 *
 * The prompt cache state (attachment ledger, issued function_call item ids)
 * used to reach the rollout only at turn end, so a process killed inside a
 * turn left that turn's reminders and item ids behind, and the resumed
 * request also carried the interrupted-turn note inside its instructions.
 * Here the process dies while a request of the second turn is in flight: the
 * home is restored to its on-disk state at that moment, the conversation is
 * resumed, and the first request after the restart must repeat the request
 * the process died in, item for item. Turns run for real over the bootstrap,
 * the daemon turn driver and a scripted Responses backend.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  controlGitBranchSpawn,
  expectPrefixKept,
  itemText,
  ResumeHarness,
  type ResumeMode,
} from "./resume-prefix-harness.js";

describe("resume after the process died mid-turn", () => {
  const harnesses: ResumeHarness[] = [];
  async function harness(mode: ResumeMode): Promise<ResumeHarness> {
    const created = await ResumeHarness.create(mode);
    harnesses.push(created);
    return created;
  }

  afterEach(async () => {
    for (const created of harnesses.splice(0)) await created.dispose();
    vi.restoreAllMocks();
  });

  it.each([
    ["light", false], ["light", true], ["standard", false], ["standard", true],
  ] as const)("%s: killed at the second request of a turn (a file changed mid-turn: %s), the restart repeats that request", async (mode, fileChanged) => {
    const request = 2;
    const h = await harness(mode);
    controlGitBranchSpawn();
    await h.start(false);
    await h.turn("Read a.txt. Reply with one short sentence.");
    // The process dies when the turn's chosen request goes out: what is on
    // disk at that moment is all the restart gets.
    const turnStart = h.bodies.length;
    let killedAt = -1;
    let snapshot: string | undefined;
    h.onRequest = (_body, index) => {
      // A file the first turn read changes while the turn's first request is
      // out, so the next request carries a reminder placed mid-turn.
      if (fileChanged && index === turnStart) writeFileSync(join(h.workspace, "a.txt"), "a, changed\n");
      if (snapshot === undefined && index === turnStart + request - 1) {
        snapshot = h.snapshotHome();
        killedAt = index;
      }
    };
    await h.turn("Read b.txt. Reply with one short sentence.");
    h.onRequest = undefined;
    await h.stop();
    expect(snapshot).toBeDefined();
    h.restoreHome(snapshot!);
    await h.start(true);
    await h.turn("Read c.txt. Reply with one short sentence.");
    await h.stop();
    const killed = h.bodies[killedAt]!;
    const resumed = h.bodies[h.starts.at(-1)!]!;
    expectPrefixKept(killed, resumed);
    // The turn continues: the restart re-sends the request in flight, and
    // the interrupted-turn note follows it instead of changing the
    // instructions.
    const added = resumed.input.slice(killed.input.length).map(itemText).join("\n");
    expect(added).toContain("The previous turn was interrupted by an app or daemon restart");
    if (fileChanged) expect(killed.input.map(itemText).join("\n")).toContain("a, changed");
  }, 60_000);
});
