import { describe, expect, it } from "vitest";
import { costCommand, formatCostSummary } from "./cost.js";
import type { Session } from "../session/session.js";

function stubSession(opts: { sidecar?: { formatSummary: () => string } }): Session {
  return {
    services: {
      costSidecar: opts.sidecar,
    },
  } as unknown as Session;
}

describe("costCommand", () => {
  it("returns the daemon-bridge fallback message when no costSidecar service is bound", () => {
    const result = formatCostSummary(stubSession({}));
    expect(result).toContain("Cost tracking is not yet wired");
    expect(result).toContain("/usage");
  });

  it("delegates to costSidecar.formatSummary when bound", () => {
    const sidecar = { formatSummary: () => "session cost: $0.42 (12.3k tokens)" };
    expect(formatCostSummary(stubSession({ sidecar }))).toBe(
      "session cost: $0.42 (12.3k tokens)",
    );
  });

  it("execute() returns a text result", async () => {
    const result = await costCommand.execute({
      session: stubSession({
        sidecar: { formatSummary: () => "session cost: $0.00" },
      }),
      argsRaw: "",
      cwd: "/tmp/ws",
      home: "/tmp/home",
    });
    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).toContain("session cost");
    }
  });
});
