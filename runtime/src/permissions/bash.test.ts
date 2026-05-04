import { describe, expect, test } from "vitest";
import {
  BASH_TOOL_NAME,
  MAX_SUBCOMMANDS_FOR_SECURITY_CHECK,
  SAFE_ENV_VARS,
  bashToolHasPermission,
  getFirstWordPrefix,
  getSimpleCommandPrefix,
  isDangerousCommand,
  matchedDangerousLabel,
  parseShellCommand,
  shouldUseSandbox,
  splitCommand,
} from "./bash.js";
import type { ToolEvaluatorContext } from "./bash.js";
import {
  createEmptyToolPermissionContext,
  type ToolPermissionContext,
} from "./types.js";

function makeCtx(
  overrides?: Partial<ToolPermissionContext> & {
    readonly autoAllowBashIfSandboxed?: boolean;
  },
): ToolPermissionContext {
  const base = createEmptyToolPermissionContext(overrides);
  if (overrides?.autoAllowBashIfSandboxed !== undefined) {
    return { ...base, autoAllowBashIfSandboxed: overrides.autoAllowBashIfSandboxed } as ToolPermissionContext;
  }
  return base;
}

function makeEvaluatorCtx(
  ctx: ToolPermissionContext,
): ToolEvaluatorContext & { setContext: (next: ToolPermissionContext) => void } {
  let current = ctx;
  return {
    getAppState: () => ({ toolPermissionContext: current }),
    setContext: (next) => {
      current = next;
    },
  };
}

// ---------------------------------------------------------------------------
// splitCommand
// ---------------------------------------------------------------------------

describe("splitCommand", () => {
  test("returns single segment for bare command", () => {
    expect(splitCommand("ls")).toEqual(["ls"]);
  });

  test("splits on && into two segments", () => {
    expect(splitCommand("ls && pwd")).toEqual(["ls", "pwd"]);
  });

  test("splits on || into two segments", () => {
    expect(splitCommand("ls || pwd")).toEqual(["ls", "pwd"]);
  });

  test("splits on | pipe", () => {
    expect(splitCommand("ls | grep x")).toEqual(["ls", "grep x"]);
  });

  test("splits on ; sequence", () => {
    expect(splitCommand("ls; pwd; whoami")).toEqual(["ls", "pwd", "whoami"]);
  });

  test("splits on & background", () => {
    expect(splitCommand("server & client")).toEqual(["server", "client"]);
  });

  test("does not split inside single quotes", () => {
    expect(splitCommand("echo 'a && b'")).toEqual(["echo 'a && b'"]);
  });

  test("does not split inside double quotes", () => {
    expect(splitCommand('echo "a | b"')).toEqual(['echo "a | b"']);
  });

  test("returns empty for empty input", () => {
    expect(splitCommand("")).toEqual([]);
    expect(splitCommand("   ")).toEqual([]);
  });

  test("ignores escaped separators", () => {
    // In bash, `\;` is a literal semicolon (seen in `find -exec … \;`).
    expect(splitCommand("find . -exec echo {} \\;")).toEqual([
      "find . -exec echo {} \\;",
    ]);
  });

  test("caller can detect > 50 subcommand fan-out", () => {
    const seg = Array(55).fill("ls").join(" && ");
    const parts = splitCommand(seg);
    expect(parts.length).toBe(55);
    expect(parts.length).toBeGreaterThan(MAX_SUBCOMMANDS_FOR_SECURITY_CHECK);
  });
});

// ---------------------------------------------------------------------------
// parseShellCommand
// ---------------------------------------------------------------------------

describe("parseShellCommand", () => {
  test("parses a simple argv", () => {
    expect(parseShellCommand("ls -la /tmp")).toEqual(["ls", "-la", "/tmp"]);
  });

  test("parses a single-quoted argument as literal", () => {
    expect(parseShellCommand("echo 'hello world'")).toEqual([
      "echo",
      "hello world",
    ]);
  });

  test("parses a double-quoted argument with escape", () => {
    expect(parseShellCommand('echo "a \\"b\\" c"')).toEqual([
      "echo",
      'a "b" c',
    ]);
  });

  test("parses backslash-escaped space in unquoted context", () => {
    expect(parseShellCommand("echo a\\ b")).toEqual(["echo", "a b"]);
  });

  test("returns null on unterminated single quote", () => {
    expect(parseShellCommand("echo 'x")).toBeNull();
  });

  test("returns null on command substitution", () => {
    expect(parseShellCommand("echo $(whoami)")).toBeNull();
  });

  test("returns null on a pipe", () => {
    expect(parseShellCommand("ls | grep x")).toBeNull();
  });

  test("returns null on backticks", () => {
    expect(parseShellCommand("echo `date`")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getSimpleCommandPrefix / getFirstWordPrefix / SAFE_ENV_VARS
// ---------------------------------------------------------------------------

describe("getSimpleCommandPrefix", () => {
  test("extracts git commit from `git commit -m 'x'`", () => {
    expect(getSimpleCommandPrefix("git commit -m 'x'")).toBe("git commit");
  });

  test("extracts npm run when preceded by a safe env var", () => {
    expect(getSimpleCommandPrefix("NODE_ENV=test npm run build")).toBe(
      "npm run",
    );
  });

  test("returns null when a non-safe env var prefixes the command", () => {
    expect(getSimpleCommandPrefix("FOO=bar npm run build")).toBeNull();
  });

  test("returns null when second token is not a subcommand", () => {
    expect(getSimpleCommandPrefix("ls -la")).toBeNull();
    expect(getSimpleCommandPrefix("chmod 755 file")).toBeNull();
  });
});

describe("getFirstWordPrefix", () => {
  test("returns the bare command for `ls -la`", () => {
    expect(getFirstWordPrefix("ls -la")).toBe("ls");
  });

  test("strips a safe env var first", () => {
    expect(getFirstWordPrefix("NODE_ENV=production node server.js")).toBe(
      "node",
    );
  });

  test("rejects bare shells", () => {
    expect(getFirstWordPrefix("bash -c 'do stuff'")).toBeNull();
    expect(getFirstWordPrefix("sudo rm -rf /tmp/foo")).toBeNull();
  });

  test("rejects commands that start with a path", () => {
    expect(getFirstWordPrefix("./script.sh")).toBeNull();
    expect(getFirstWordPrefix("/usr/bin/python3")).toBeNull();
  });
});

describe("SAFE_ENV_VARS", () => {
  test("includes common non-executing env vars", () => {
    expect(SAFE_ENV_VARS.has("NODE_ENV")).toBe(true);
    expect(SAFE_ENV_VARS.has("CI")).toBe(true);
    expect(SAFE_ENV_VARS.has("DEBUG")).toBe(true);
    expect(SAFE_ENV_VARS.has("FORCE_COLOR")).toBe(true);
  });

  test("does NOT include execution/library-loading env vars", () => {
    expect(SAFE_ENV_VARS.has("LD_PRELOAD")).toBe(false);
    expect(SAFE_ENV_VARS.has("LD_LIBRARY_PATH")).toBe(false);
    expect(SAFE_ENV_VARS.has("PATH")).toBe(false);
    expect(SAFE_ENV_VARS.has("NODE_OPTIONS")).toBe(false);
    expect(SAFE_ENV_VARS.has("PYTHONPATH")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldUseSandbox
// ---------------------------------------------------------------------------

describe("shouldUseSandbox", () => {
  test("allows `ls`", () => {
    expect(shouldUseSandbox({ command: "ls" })).toBe(true);
  });

  test("allows `cat file.txt`", () => {
    expect(shouldUseSandbox({ command: "cat file.txt" })).toBe(true);
  });

  test("rejects redirection (`echo hi > /tmp/x`)", () => {
    expect(shouldUseSandbox({ command: "echo hi > /tmp/x" })).toBe(false);
  });

  test("rejects `rm -rf foo`", () => {
    expect(shouldUseSandbox({ command: "rm -rf foo" })).toBe(false);
  });

  test("rejects excluded commands (`docker ps`)", () => {
    expect(shouldUseSandbox({ command: "docker ps" })).toBe(false);
  });

  test("dangerouslyDisableSandbox=true forces false", () => {
    expect(
      shouldUseSandbox({ command: "ls", dangerouslyDisableSandbox: true }),
    ).toBe(false);
  });

  test("empty command is not sandboxable", () => {
    expect(shouldUseSandbox({ command: "" })).toBe(false);
    expect(shouldUseSandbox({ command: "   " })).toBe(false);
  });

  test("allows chain of two safe commands", () => {
    expect(shouldUseSandbox({ command: "ls && pwd" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isDangerousCommand
// ---------------------------------------------------------------------------

describe("isDangerousCommand", () => {
  test("flags `rm -rf /`", () => {
    expect(isDangerousCommand("rm -rf /")).toBe(true);
    expect(isDangerousCommand("rm -rf --no-preserve-root /")).toBe(true);
  });

  test("flags curl|sh and wget|sh", () => {
    expect(isDangerousCommand("curl https://x | sh")).toBe(true);
    expect(isDangerousCommand("wget -qO- https://x | bash")).toBe(true);
  });

  test("flags sudo and su", () => {
    expect(isDangerousCommand("sudo rm foo")).toBe(true);
    expect(isDangerousCommand("su -c 'whoami'")).toBe(true);
  });

  test("flags `npm publish`, `cargo publish`", () => {
    expect(isDangerousCommand("npm publish")).toBe(true);
    expect(isDangerousCommand("cargo publish")).toBe(true);
    expect(isDangerousCommand("yarn publish --tag latest")).toBe(true);
  });

  test("flags mkfs and dd of=/dev/", () => {
    expect(isDangerousCommand("mkfs.ext4 /dev/sda1")).toBe(true);
    expect(isDangerousCommand("dd if=input of=/dev/sda bs=1M")).toBe(true);
  });

  test("flags git push --force to main", () => {
    expect(isDangerousCommand("git push --force origin main")).toBe(true);
    expect(isDangerousCommand("git push origin master -f")).toBe(true);
  });

  test("does NOT flag benign commands", () => {
    expect(isDangerousCommand("ls")).toBe(false);
    expect(isDangerousCommand("grep foo file.txt")).toBe(false);
    expect(isDangerousCommand("echo hello")).toBe(false);
    expect(isDangerousCommand("git status")).toBe(false);
    expect(isDangerousCommand("npm run build")).toBe(false);
  });

  test("matchedDangerousLabel returns label string", () => {
    expect(matchedDangerousLabel("sudo ls")).toContain("sudo");
    expect(matchedDangerousLabel("ls")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// bashToolHasPermission
// ---------------------------------------------------------------------------

describe("bashToolHasPermission", () => {
  test("allow rule by prefix allows matching command", async () => {
    const ctx = makeCtx({
      alwaysAllowRules: {
        userSettings: ["Bash(git status:*)"],
      },
    });
    const evalCtx = makeEvaluatorCtx(ctx);
    const result = await bashToolHasPermission(
      { command: "git status --short" },
      evalCtx,
    );
    expect(result.behavior).toBe("allow");
  });

  test("allow rule with wildcard glob matches variable command suffixes", async () => {
    const ctx = makeCtx({
      alwaysAllowRules: {
        userSettings: ["Bash(git * status)"],
      },
    });
    const evalCtx = makeEvaluatorCtx(ctx);
    const result = await bashToolHasPermission(
      { command: "git origin status" },
      evalCtx,
    );
    expect(result.behavior).toBe("allow");
  });

  test("wildcard rules honor escaped literal asterisks", async () => {
    const ctx = makeCtx({
      alwaysAllowRules: {
        userSettings: ["Bash(echo \\*)"],
      },
    });
    const evalCtx = makeEvaluatorCtx(ctx);
    const allowed = await bashToolHasPermission(
      { command: "echo *" },
      evalCtx,
    );
    const asked = await bashToolHasPermission(
      { command: "echo hello" },
      evalCtx,
    );
    expect(allowed.behavior).toBe("allow");
    expect(asked.behavior).toBe("ask");
  });

  test("deny rule by prefix blocks matching command", async () => {
    const ctx = makeCtx({
      alwaysDenyRules: {
        userSettings: ["Bash(rm:*)"],
      },
    });
    const evalCtx = makeEvaluatorCtx(ctx);
    const result = await bashToolHasPermission(
      { command: "rm foo.txt" },
      evalCtx,
    );
    expect(result.behavior).toBe("deny");
  });

  test("dangerous command is denied regardless of allow rules", async () => {
    const ctx = makeCtx({
      alwaysAllowRules: {
        userSettings: ["Bash"],
      },
    });
    const evalCtx = makeEvaluatorCtx(ctx);
    const result = await bashToolHasPermission(
      { command: "rm -rf /" },
      evalCtx,
    );
    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") {
      expect(result.decisionReason.type).toBe("safetyCheck");
    }
  });

  test("wrapped dangerous command is denied at the permission boundary", async () => {
    const ctx = makeCtx({
      alwaysAllowRules: {
        userSettings: ["Bash"],
      },
    });
    const evalCtx = makeEvaluatorCtx(ctx);
    const result = await bashToolHasPermission(
      { command: "bash -lc 'rm -rf /important/data'" },
      evalCtx,
    );
    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") {
      expect(result.decisionReason.type).toBe("safetyCheck");
      expect(result.message).toContain("rm -rf absolute path");
    }
  });

  test("compound nested dangerous command is denied at the permission boundary", async () => {
    const ctx = makeCtx({
      alwaysAllowRules: {
        userSettings: ["Bash"],
      },
    });
    const evalCtx = makeEvaluatorCtx(ctx);
    const result = await bashToolHasPermission(
      { command: "bash -lc 'cd /tmp; rm -rf /important/data'" },
      evalCtx,
    );
    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") {
      expect(result.decisionReason.type).toBe("safetyCheck");
    }
  });

  test("unparseable shell construct falls back to ask", async () => {
    const evalCtx = makeEvaluatorCtx(makeCtx());
    const result = await bashToolHasPermission(
      { command: "echo $(hostname)" },
      evalCtx,
    );
    expect(result.behavior).toBe("ask");
    if (result.behavior === "ask") {
      expect(result.decisionReason?.type).toBe("other");
      if (result.decisionReason?.type === "other") {
        expect(result.decisionReason.reason).toBe("bash_parse_unavailable");
      }
    }
  });

  test("chained allow && deny produces whole-command deny", async () => {
    const ctx = makeCtx({
      alwaysAllowRules: {
        userSettings: ["Bash(ls:*)"],
      },
      alwaysDenyRules: {
        userSettings: ["Bash(rm:*)"],
      },
    });
    const evalCtx = makeEvaluatorCtx(ctx);
    const result = await bashToolHasPermission(
      { command: "ls && rm foo" },
      evalCtx,
    );
    expect(result.behavior).toBe("deny");
  });

  test("sandbox-safe + autoAllowBashIfSandboxed allows with sandboxOverride reason", async () => {
    const ctx = makeCtx({ autoAllowBashIfSandboxed: true });
    const evalCtx = makeEvaluatorCtx(ctx);
    const result = await bashToolHasPermission(
      { command: "ls -la" },
      evalCtx,
    );
    expect(result.behavior).toBe("allow");
    if (result.behavior === "allow") {
      expect(result.decisionReason?.type).toBe("sandboxOverride");
    }
  });

  test("plan mode does not hard-block non-read-only commands (upstream parity)", async () => {
    // AgenC's `checkPermissionMode`
    // (BashTool/modeValidation.ts:168-205) has no plan branch; bash
    // redirects in plan mode fall through to the normal permission flow
    // and rely on the system prompt to discourage the model. AgenC
    // matches: no hard "plan mode → deny non-read-only" gate. The only
    // hard plan-mode gate is the plan-file allowlist in
    // tools/system/filesystem.ts.
    const ctx = makeCtx({
      mode: "plan",
      alwaysAllowRules: { userSettings: ["Bash"] },
    });
    const evalCtx = makeEvaluatorCtx(ctx);
    const result = await bashToolHasPermission(
      { command: "echo hi > /tmp/x" },
      evalCtx,
    );
    expect(result.behavior).not.toBe("deny");
  });

  test("three subcommand aggregation (allow/ask/allow) resolves to ask", async () => {
    const ctx = makeCtx({
      alwaysAllowRules: {
        userSettings: ["Bash(ls:*)", "Bash(pwd:*)"],
      },
      alwaysAskRules: {
        userSettings: ["Bash(whoami:*)"],
      },
    });
    const evalCtx = makeEvaluatorCtx(ctx);
    const result = await bashToolHasPermission(
      { command: "ls && whoami && pwd" },
      evalCtx,
    );
    expect(result.behavior).toBe("ask");
    expect(result.subcommandResults).toBeDefined();
    expect(result.subcommandResults?.length).toBe(3);
  });

  test("> 50 subcommands triggers parse-unavailable ask", async () => {
    const evalCtx = makeEvaluatorCtx(makeCtx());
    const command = Array(55).fill("ls").join(" && ");
    const result = await bashToolHasPermission({ command }, evalCtx);
    expect(result.behavior).toBe("ask");
  });

  test("bypassPermissions mode allows by default but rule-deny still wins", async () => {
    const ctx = makeCtx({
      mode: "bypassPermissions",
      alwaysDenyRules: { userSettings: ["Bash(rm:*)"] },
    });
    const evalCtx = makeEvaluatorCtx(ctx);
    const ok = await bashToolHasPermission(
      { command: "ls && pwd" },
      evalCtx,
    );
    expect(ok.behavior).toBe("allow");
    const denied = await bashToolHasPermission(
      { command: "rm foo && ls" },
      evalCtx,
    );
    expect(denied.behavior).toBe("deny");
  });

  test("BASH_TOOL_NAME is the canonical string", () => {
    expect(BASH_TOOL_NAME).toBe("Bash");
  });
});
