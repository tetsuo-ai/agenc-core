import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, test } from "vitest";

import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { findSuitableShell } from "../../src/utils/Shell.js";

describe("explicit shell selection", () => {
  test("rejects a missing explicit shell instead of silently detecting another", async () => {
    const missingShell = join(
      tmpdir(),
      "agenc-explicit-shell-that-does-not-exist",
      String(process.pid),
      process.platform === "win32" ? "bash.exe" : "bash",
    );
    const runtimeOptions = resolveAgentRuntimeOptions({
      AGENC_SHELL: missingShell,
    });

    await expect(findSuitableShell(runtimeOptions)).rejects.toThrow(
      `Configured shell ${JSON.stringify(missingShell)} is not executable`,
    );
  });
});
