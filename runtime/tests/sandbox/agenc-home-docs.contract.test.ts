import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  protectAgencHomeUnderWritableRoot,
  sandboxAgencHome,
} from "../../src/sandbox/agenc-home-protection.js";
import { sandboxModeRequiresPlatformIsolation } from "../../src/tools/runtimes/sandboxing.js";

const LANDLOCK_RESERVED_REASON =
  "reserved Desktop authority paths require non-overridable read-only carve-outs; bubblewrap is required";

/** Markdown prose wraps at any space; compare sentences with whitespace collapsed. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

describe("AgenC home under writable sandbox roots docs", () => {
  it("pins the shipped reservation, isolation modes, and Landlock refusal", async () => {
    expect(sandboxModeRequiresPlatformIsolation("read_only")).toBe(true);
    expect(sandboxModeRequiresPlatformIsolation("workspace_write")).toBe(true);
    expect(sandboxModeRequiresPlatformIsolation("danger_full_access")).toBe(false);
    expect(sandboxModeRequiresPlatformIsolation("external_sandbox")).toBe(false);
    expect(typeof protectAgencHomeUnderWritableRoot).toBe("function");
    expect(typeof sandboxAgencHome).toBe("function");

    const [protection, landlock, sandboxing] = await Promise.all([
      readFile("src/sandbox/agenc-home-protection.ts", "utf8"),
      readFile("src/sandbox/linux-launcher/landlock-exec.ts", "utf8"),
      readFile("src/tools/runtimes/sandboxing.ts", "utf8"),
    ]);
    expect(protection).toContain("grantedProfile");
    expect(protection).toContain("protectDesktopAuthority");
    expect(landlock).toContain(LANDLOCK_RESERVED_REASON);
    expect(sandboxing).toContain("agencHomeCarveOutAllowsWrite");
    expect(sandboxing).toContain("shellAccess === null");
  });

  it("documents host vs sandbox, Landlock refusal, and no override", async () => {
    const sandbox = await readFile(
      "../docs/reference/tools-permissions-sandbox.md",
      "utf8",
    );

    expect(sandbox).toContain("### AgenC home under writable sandbox roots");
    expect(sandbox).toContain("`protectAgencHomeUnderWritableRoot`");
    expect(sandbox).toContain("`sandboxAgencHome`");
    expect(sandbox).toContain("`reservedReadOnlyPaths`");
    expect(sandbox).toContain("grantedProfile");
    expect(sandbox).toContain("`agencHomeCarveOutAllowsWrite`");
    expect(sandbox).toContain("shellAccess === null");
    expect(sandbox).toContain("There is no env or `config.toml` override");
    expect(sandbox).toContain(LANDLOCK_RESERVED_REASON);
    expect(sandbox).toContain("[sandbox_policy_unexpressible]");
    expect(flat(sandbox)).toContain(
      "do not treat this as the `.git` / `.agenc` unexpressible case",
    );
    expect(sandbox).toContain("#home-workspace-vs-helper-containment");
  });

  it("points INDEX, architecture, env, config, daemon, install, and memory at the same contract", async () => {
    const [index, architecture, env, config, daemon, install, memory, failClosed] =
      await Promise.all([
        readFile("../docs/INDEX.md", "utf8"),
        readFile("../docs/ARCHITECTURE.md", "utf8"),
        readFile("../docs/reference/env.md", "utf8"),
        readFile("../docs/reference/config.md", "utf8"),
        readFile("../docs/reference/daemon.md", "utf8"),
        readFile("../docs/install.md", "utf8"),
        readFile("../docs/reference/memory.md", "utf8"),
        readFile("../docs/design/fail-closed-sandbox-execution.md", "utf8"),
      ]);

    expect(index).toContain(
      "tools-permissions-sandbox.md#agenc-home-under-writable-sandbox-roots",
    );
    expect(architecture).toContain(
      "tools-permissions-sandbox.md#agenc-home-under-writable-sandbox-roots",
    );
    expect(env).toContain(
      "tools-permissions-sandbox.md#agenc-home-under-writable-sandbox-roots",
    );
    expect(config).toContain(
      "tools-permissions-sandbox.md#agenc-home-under-writable-sandbox-roots",
    );
    expect(daemon).toContain(
      "tools-permissions-sandbox.md#agenc-home-under-writable-sandbox-roots",
    );
    expect(install).toContain(
      "tools-permissions-sandbox.md#agenc-home-under-writable-sandbox-roots",
    );
    expect(memory).toContain(
      "tools-permissions-sandbox.md#agenc-home-under-writable-sandbox-roots",
    );
    expect(failClosed).toContain(
      "tools-permissions-sandbox.md#agenc-home-under-writable-sandbox-roots",
    );
  });
});
