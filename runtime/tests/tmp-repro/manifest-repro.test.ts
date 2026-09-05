import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";
import { FileThreadStore } from "../../src/thread-store/store.js";

it("reproduces the manifest mismatch on the soak rollout", () => {
  const home = mkdtempSync("/private/tmp/tt/repro-home-");
  const projectDir = join(home, "projects", "work-repro");
  mkdirSync(join(projectDir, "sessions"), { recursive: true });
  cpSync("/private/tmp/tt/repro-sess/conv-mtnmmso6", join(projectDir, "sessions", "conv-mtnmmso6"), { recursive: true });
  const store = new FileThreadStore({ projectDir, agencHome: home });
  try {
    const thread = store.readThread({ threadId: "conv-mtnmmso6", includeArchived: true, includeHistory: true });
    console.log("READ OK items=", thread.history?.items.length);
  } catch (error) {
    const e = error as Error & { cause?: Error };
    console.log("READ FAILED:", e.message, "\n", (e.stack ?? "").split("\n").slice(0, 14).join("\n"), "\nCAUSE:", e.cause?.message, (e.cause?.stack ?? "").split("\n").slice(0, 8).join("\n"));
  }
});
