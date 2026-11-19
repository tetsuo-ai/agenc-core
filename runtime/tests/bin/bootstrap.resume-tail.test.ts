/**
 * A resumed session keeps the session tail it sent before.
 *
 * Base instructions, whose tail names the current date and the git branch,
 * are built once per session object. A live session therefore never sees a
 * new date or branch, but a resume builds a new session object and used to
 * read both again: after midnight UTC, after a branch switch, or when the
 * sandboxed git read failed under load, the first item of the resumed
 * request changed and the provider's prompt cache read nothing of the
 * earlier conversation. These turns run for real over the bootstrap, the
 * daemon turn driver and a scripted Responses backend.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONVERSATION_ID,
  controlGitBranchSpawn,
  expectPrefixKept,
  git,
  itemText,
  ResumeHarness,
  type ResumeMode,
} from "./resume-prefix-harness.js";

describe("resumed session tail", () => {
  const harnesses: ResumeHarness[] = [];
  async function harness(mode: ResumeMode): Promise<ResumeHarness> {
    const created = await ResumeHarness.create(mode);
    harnesses.push(created);
    return created;
  }

  afterEach(async () => {
    vi.useRealTimers();
    for (const created of harnesses.splice(0)) await created.dispose();
    vi.restoreAllMocks();
  });

  it.each(["light", "standard"] as const)(
    "%s: a resumed turn repeats the previous request and matches one live session",
    async (mode) => {
      const h = await harness(mode);
      controlGitBranchSpawn();
      await h.start(false);
      await h.turn("Read a.txt. Reply with one short sentence.");
      await h.stop();
      await h.start(true);
      await h.turn("Read b.txt. Reply with one short sentence.");
      await h.stop();
      const split = h.starts[1]!;
      expectPrefixKept(h.bodies[split - 1]!, h.bodies[split]!);
      const resumed = h.normalized(h.bodies, CONVERSATION_ID);

      const live = h.bodies.length;
      await h.start(false, "conv-live-1");
      await h.turn("Read a.txt. Reply with one short sentence.");
      await h.turn("Read b.txt. Reply with one short sentence.");
      await h.stop();
      expect(h.normalized(h.bodies.slice(live), "conv-live-1")).toEqual(resumed);
    },
    120_000,
  );

  it("standard: the branch line stays when the branch changed before the resume", async () => {
    const h = await harness("standard");
    controlGitBranchSpawn();
    await h.start(false);
    await h.turn("Read a.txt. Reply with one short sentence.");
    await h.stop();
    git(h.workspace, "checkout", "-q", "-b", "feature/other");
    await h.start(true);
    await h.turn("Read b.txt. Reply with one short sentence.");
    await h.stop();
    const split = h.starts[1]!;
    expect(JSON.stringify(h.bodies[0])).toContain("Git branch: main");
    expectPrefixKept(h.bodies[split - 1]!, h.bodies[split]!);
  }, 60_000);

  it("standard: the branch line stays when the branch read fails on resume", async () => {
    const h = await harness("standard");
    let resumed = false;
    controlGitBranchSpawn(() => resumed);
    await h.start(false);
    await h.turn("Read a.txt. Reply with one short sentence.");
    await h.stop();
    resumed = true;
    await h.start(true);
    await h.turn("Read b.txt. Reply with one short sentence.");
    await h.stop();
    const split = h.starts[1]!;
    expect(JSON.stringify(h.bodies[0])).toContain("Git branch: main");
    expectPrefixKept(h.bodies[split - 1]!, h.bodies[split]!);
  }, 60_000);

  it("standard: a fresh session reads the branch without spawning git", async () => {
    const h = await harness("standard");
    controlGitBranchSpawn(() => true);
    await h.start(false);
    await h.turn("Read a.txt. Reply with one short sentence.");
    await h.stop();
    expect(JSON.stringify(h.bodies[0])).toContain("Git branch: main");
  }, 60_000);

  it.each(["light", "standard"] as const)(
    "%s: a resume after the UTC date changed keeps the tail and tells the model the new date",
    async (mode) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-19T23:58:00.000Z"));
      const h = await harness(mode);
      controlGitBranchSpawn();
      await h.start(false);
      await h.turn("Read a.txt. Reply with one short sentence.");
      await h.stop();
      vi.setSystemTime(new Date("2026-11-20T00:03:00.000Z"));
      await h.start(true);
      await h.turn("Read b.txt. Reply with one short sentence.");
      await h.stop();
      const split = h.starts[1]!;
      expect(JSON.stringify(h.bodies[0])).toContain("Current date (UTC): 2026-11-19");
      expectPrefixKept(h.bodies[split - 1]!, h.bodies[split]!);
      const added = h.bodies[split]!.input.slice(h.bodies[split - 1]!.input.length);
      expect(added.map(itemText).join("\n")).toContain("Today's date is now 2026-11-20");
    },
    60_000,
  );
});
