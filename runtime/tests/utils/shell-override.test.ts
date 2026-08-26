import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";

import { describe, expect, test } from "vitest";

import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { findSuitableShell } from "../../src/utils/Shell.js";
import { runWithCurrentRuntimeSession } from "../../src/session/current-session.js";
import type { Session } from "../../src/session/session.js";

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

  test("explicit ingress resolution does not inherit another session shell", async () => {
    if (process.platform === "win32") return;
    const runtimeOptions = resolveAgentRuntimeOptions({});
    const otherSession = {
      services: {
        runtimeOptions: resolveAgentRuntimeOptions({ AGENC_SHELL: "/bin/zsh" }),
        userShell: {
          path: "/bin/zsh",
          commandWrapperArgv: [],
          childEnvironment: {},
          deriveExecArgs: (input: string) => ["-c", input],
        },
      },
    } as unknown as Session;

    await expect(
      runWithCurrentRuntimeSession(otherSession, () =>
        findSuitableShell(runtimeOptions, { SHELL: "/bin/bash" }),
      ),
    ).resolves.toBe("/bin/bash");
  });

  test("does not promote a client PATH executable into shell authority", async () => {
    if (process.platform === "win32") return;
    const directory = mkdtempSync(join(tmpdir(), "agenc-shell-path-"));
    const clientBash = join(directory, "bash");
    symlinkSync(process.execPath, clientBash);
    try {
      await expect(
        findSuitableShell(resolveAgentRuntimeOptions({}), {
          PATH: directory,
        }),
      ).resolves.not.toBe(clientBash);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
