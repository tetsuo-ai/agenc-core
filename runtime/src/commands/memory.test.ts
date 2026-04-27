import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import memoryCommand from "./memory.js";
import { getSessionMemoryMode } from "../prompts/memory/index.js";

function ctx(argsRaw: string, agencHome?: string) {
  const session = {} as never;
  return {
    session,
    argsRaw,
    cwd: "/tmp",
    home: "/tmp",
    ...(agencHome !== undefined ? { agencHome } : {}),
  };
}

describe("/memory", () => {
  it("sets current session memory mode", async () => {
    const commandCtx = ctx("off");
    const result = await memoryCommand.execute(commandCtx);
    expect(result.kind).toBe("text");
    expect(getSessionMemoryMode(commandCtx.session)).toBe("disabled");
  });

  it("refuses clear without confirmation", async () => {
    const result = await memoryCommand.execute(ctx("clear", "/tmp/agenc"));
    expect(result.kind).toBe("error");
  });

  it("creates a summary on summarize", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-memory-command-"));
    try {
      const result = await memoryCommand.execute(ctx("summarize", agencHome));
      expect(result.kind).toBe("text");
      if (result.kind === "text") {
        expect(result.text).toContain("Memory Summary");
      }
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });
});

