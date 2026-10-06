import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../src/session/session.js";
import type { SlashCommandContext } from "../../src/commands/types.js";

const loading = vi.hoisted(() => ({ evaluations: 0 }));
vi.mock("../../src/commands/session-compact.js", async original => {
  loading.evaluations++;
  return original();
});

describe("compaction command loading", () => {
  it("keeps the implementation unloaded through registry lookup, then executes the real command", async () => {
    const { buildDefaultRegistry } = await import("../../src/commands/registry.js");
    const registry = buildDefaultRegistry();
    const compact = registry.find("compact")!;
    const context = registry.find("context")!;
    expect(registry.find("ctx")).toBe(context);
    expect(compact.supportsNonInteractive).toBe(true);
    expect(context.supportedSurfaces).toEqual(["runtime", "daemon-tui"]);
    expect(loading.evaluations).toBe(0);

    const partialCompactFromMessage = vi.fn(async () => ({
      ok: true, displayText: "Compacted by the daemon",
    }));
    const ctx = {
      session: { partialCompactFromMessage } as unknown as Session,
      argsRaw: "  retain the plan  ", cwd: "/tmp", home: "/tmp",
    } satisfies SlashCommandContext;
    expect(await compact.execute(ctx)).toEqual({
      kind: "compact", text: "Compacted by the daemon",
    });
    expect(partialCompactFromMessage).toHaveBeenCalledWith({
      messageOrdinal: 0, direction: "from", feedback: "retain the plan",
    });
    expect(loading.evaluations).toBe(1);
    const implementation = await import("../../src/commands/session-compact.js");
    expect(implementation.compactCommand).toBe(compact);
    expect(implementation.contextCommand).toBe(context);
    expect(await compact.execute(ctx)).toEqual({
      kind: "compact", text: "Compacted by the daemon",
    });
    expect(loading.evaluations).toBe(1);
  }, 30_000);
});
