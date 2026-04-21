import { beforeEach, describe, expect, it, vi } from "vitest";
import compactCommand, {
  formatCompactOutcome,
  runCompact,
} from "./compact.js";
import type { Session } from "../session/session.js";
import type { SlashCommandContext } from "./types.js";

const mocks = vi.hoisted(() => ({
  runSessionManualCompact: vi.fn(),
  path: new URL("../session/manual-compact.js", import.meta.url).pathname,
}));

vi.mock(mocks.path, () => ({
  runSessionManualCompact: mocks.runSessionManualCompact,
}));

function stubSession(): Session {
  return {} as Session;
}

function mkctx(session: Session, argsRaw = ""): SlashCommandContext {
  return { session, argsRaw, cwd: "/ws", home: "/home/test" };
}

describe("compactCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is userInvocable and immediate", () => {
    expect(compactCommand.userInvocable).toBe(true);
    expect(compactCommand.immediate).toBe(true);
    expect(compactCommand.name).toBe("compact");
  });

  it("delegates runCompact to the session-owned path", async () => {
    const session = stubSession();
    mocks.runSessionManualCompact.mockResolvedValueOnce({
      kind: "ran",
      text: "Compacted",
      instructions: "keep latest",
    });

    const outcome = await runCompact(session, "keep latest");

    expect(mocks.runSessionManualCompact).toHaveBeenCalledWith(
      session,
      "keep latest",
    );
    expect(outcome).toEqual({
      kind: "ran",
      text: "Compacted",
      instructions: "keep latest",
    });
  });

  it("renders blocked results as slash-command errors", async () => {
    mocks.runSessionManualCompact.mockResolvedValueOnce({
      kind: "blocked",
      reason: "busy",
    });

    const result = await compactCommand.execute(mkctx(stubSession(), ""));

    expect(result).toEqual({
      kind: "error",
      message: "Cannot compact right now: busy.",
    });
  });

  it("renders ran results as slash-command compact responses", async () => {
    mocks.runSessionManualCompact.mockResolvedValueOnce({
      kind: "ran",
      text: "Compacted\nsummary",
      instructions: "",
    });

    const result = await compactCommand.execute(mkctx(stubSession(), ""));

    expect(result).toEqual({
      kind: "compact",
      text: "Compacted\nsummary",
    });
  });

  it("formatCompactOutcome renders each kind", () => {
    expect(
      formatCompactOutcome({ kind: "blocked", reason: "busy" }),
    ).toMatch(/Cannot compact/);
    expect(
      formatCompactOutcome({
        kind: "ran",
        text: "Compaction complete.",
        instructions: "",
      }),
    ).toBe("Compaction complete.");
    expect(
      formatCompactOutcome({ kind: "error", cause: "boom" }),
    ).toMatch(/Compaction failed: boom/);
  });
});
