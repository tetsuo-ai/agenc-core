import { describe, expect, test } from "vitest";

import { ConfiguredHooksRuntime, matchesPattern } from "./configured-hooks.js";

describe("configured hooks runtime", () => {
  test("matches exact, pipe, wildcard, and regex patterns", () => {
    expect(matchesPattern("Read", "Read")).toBe(true);
    expect(matchesPattern("Read", "Grep|Read")).toBe(true);
    expect(matchesPattern("Read", "*")).toBe(true);
    expect(matchesPattern("Read", "^Re")).toBe(true);
    expect(matchesPattern("Read", "Write")).toBe(false);
  });

  test("loads config hooks into live tool hook arrays", async () => {
    const runtime = new ConfiguredHooksRuntime({
      cwd: process.cwd(),
      env: process.env,
      agencHome: "/tmp/agenc-test",
      shellPath: process.env.SHELL ?? "/bin/sh",
    });
    const target = {
      preToolUseHooks: [],
      postToolUseHooks: [],
      failureToolUseHooks: [],
      permissionDecisionHooks: [],
      stopHooks: [],
      stopFailureHooks: [],
    };
    runtime.attachTarget(target);
    runtime.load({
      PreToolUse: [
        {
          matcher: "Read",
          hooks: [{ type: "command", command: "printf ok" }],
        },
      ],
      Stop: [
        {
          hooks: [{ type: "command", command: "printf done" }],
        },
      ],
    });

    expect(target.preToolUseHooks).toHaveLength(1);
    expect(target.stopHooks).toHaveLength(1);
    const hook = runtime.listHooks()[0]!;
    const diag = await runtime.testHook(hook);
    expect(diag.status).toBe("success");
    expect(diag.stdout).toBe("ok");
  });

  test("records blocking diagnostics for exit code 2", async () => {
    const runtime = new ConfiguredHooksRuntime({
      cwd: process.cwd(),
      env: process.env,
      agencHome: "/tmp/agenc-test",
      shellPath: process.env.SHELL ?? "/bin/sh",
    });
    runtime.load({
      PreToolUse: [
        {
          hooks: [{ type: "command", command: "printf blocked >&2; exit 2" }],
        },
      ],
    });
    const diag = await runtime.testHook(runtime.listHooks()[0]!);
    expect(diag.status).toBe("blocking");
    expect(diag.stderr).toBe("blocked");
  });
});
