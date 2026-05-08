// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));

let storedCompanion: unknown = null;
let storedMuted = false;

vi.mock("../../tui/buddy/companion.js", () => ({
  companionUserId: () => "test-user",
  getCompanion: () => storedCompanion,
  rollWithSeed: () => ({
    bones: {
      species: "Stardust Otter",
      rarity: "rare",
      personality: "bouncy",
    },
  }),
}));

vi.mock("../../utils/config.js", () => ({
  getGlobalConfig: () => ({
    companion: storedCompanion,
    companionMuted: storedMuted,
  }),
  saveGlobalConfig: (updater) => {
    const next = updater({
      companion: storedCompanion,
      companionMuted: storedMuted,
    });
    storedCompanion = next.companion ?? storedCompanion;
    storedMuted = !!next.companionMuted;
  },
}));

const { call } = await import("./buddy.js");

afterEach(() => {
  storedCompanion = null;
  storedMuted = false;
});

function makeOnDone() {
  const calls: Array<{ message: string | undefined; opts: Record<string, unknown> }> = [];
  const onDone = (message: string | undefined, opts: Record<string, unknown>) => {
    calls.push({ message, opts });
  };
  return { onDone, calls };
}

const ctx = {
  setAppState: () => {},
  getAppState: () => ({}),
} as never;

describe("buddy command call()", () => {
  it("'help' shows the help message", async () => {
    const { onDone, calls } = makeOnDone();
    await call(onDone, ctx, "help");
    expect(calls.length).toBeGreaterThan(0);
    const text = calls.map((c) => c.message ?? "").join("\n");
    expect(text.toLowerCase()).toContain("buddy");
  });

  it("'status' returns the no-buddy message when none is hatched", async () => {
    const { onDone, calls } = makeOnDone();
    await call(onDone, ctx, "status");
    expect(calls.length).toBe(1);
    expect(calls[0].message).toContain("No buddy hatched");
    expect(calls[0].opts.display).toBe("system");
  });

  it("'status' returns the companion summary when one exists", async () => {
    storedCompanion = {
      id: "c1",
      name: "Pixelmoss",
      species: "Stardust Otter",
      rarity: "rare",
      personality: "bouncy",
    };
    const { onDone, calls } = makeOnDone();
    await call(onDone, ctx, "status");
    expect(calls.length).toBe(1);
    expect(calls[0].message).toContain("Pixelmoss");
    expect(calls[0].message).toContain("Stardust Otter");
  });

  it("'mute' sets companionMuted to true", async () => {
    const { onDone, calls } = makeOnDone();
    await call(onDone, ctx, "mute");
    expect(storedMuted).toBe(true);
    expect(calls[0].message).toContain("muted");
  });

  it("'unmute' sets companionMuted to false", async () => {
    storedMuted = true;
    const { onDone, calls } = makeOnDone();
    await call(onDone, ctx, "unmute");
    expect(storedMuted).toBe(false);
    expect(calls[0].message).toContain("unmuted");
  });

  it("unknown args show the help message", async () => {
    const { onDone, calls } = makeOnDone();
    await call(onDone, ctx, "fizzbuzz");
    expect(calls.length).toBeGreaterThan(0);
    const text = calls.map((c) => c.message ?? "").join("\n");
    expect(text.toLowerCase()).toContain("buddy");
  });
});
