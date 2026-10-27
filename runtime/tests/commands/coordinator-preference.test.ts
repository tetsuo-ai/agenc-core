import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { coordinatorCommand } from "src/commands/coordinator.js";
import type { SlashCommandContext } from "src/commands/types.js";

describe("coordinator saved preference", () => {
  it("shows both saved toggles immediately without reloading the active session", async () => {
    const home = mkdtempSync(join(tmpdir(), "coordinator-preference-"));
    const ctx = { session: { config: { coordinatorMode: false } }, argsRaw: "", cwd: home, home, agencHome: home } as unknown as SlashCommandContext;
    try {
      for (const toggle of ["on", "off"]) {
        expect((await coordinatorCommand.execute({ ...ctx, argsRaw: toggle })).kind).toBe("text");
        const status = await coordinatorCommand.execute(ctx);
        expect(status.kind).toBe("text");
        if (status.kind === "text") {
          expect(status.text).toContain("Coordinator mode: off");
          expect(status.text).toContain(`Saved preference (coordinator_mode): ${toggle === "on"}`);
          expect(status.text).not.toContain("Active surface:");
        }
      }
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
