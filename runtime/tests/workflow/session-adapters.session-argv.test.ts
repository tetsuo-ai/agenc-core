/**
 * A run's own session must be bootstrapped on the model the run was started
 * with.
 *
 * The session is bootstrapped like any other agent, so it takes the daemon's
 * default model unless it is told otherwise. Only the permission mode was
 * being passed, so `run start --model` was accepted, frozen into the spec,
 * and then ignored: every run ran on whatever the daemon defaulted to, and a
 * default that cannot answer took the run down with it.
 */

import { describe, expect, it } from "vitest";

import { workflowSessionArgv } from "../../src/app-server/workflow/session-adapters.js";

const BASE = ["node", "agenc"] as const;

describe("workflowSessionArgv", () => {
  it("passes the run's model and provider", () => {
    const argv = workflowSessionArgv(
      { permissionMode: "default", model: "grok-4.6", provider: "grok" },
      BASE,
    );
    expect(argv).toContain("--model");
    expect(argv[argv.indexOf("--model") + 1]).toBe("grok-4.6");
    expect(argv).toContain("--provider");
    expect(argv[argv.indexOf("--provider") + 1]).toBe("grok");
  });

  it("keeps the permission mode it already carried", () => {
    const bypass = workflowSessionArgv(
      { permissionMode: "bypassPermissions" },
      BASE,
    );
    expect(bypass[bypass.indexOf("--permission-mode") + 1]).toBe(
      "bypassPermissions",
    );
    expect(bypass).not.toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
    const planning = workflowSessionArgv({ permissionMode: "plan" }, BASE);
    expect(planning[planning.indexOf("--permission-mode") + 1]).toBe("plan");
  });

  it("adds nothing when the spec pinned no model", () => {
    expect(workflowSessionArgv({ permissionMode: "default" }, BASE)).not.toContain(
      "--model",
    );
  });

  it("never inherits daemon launch flags over the frozen run policy", () => {
    const argv = workflowSessionArgv(
      {
        permissionMode: "plan",
        provider: "grok",
        model: "grok-4.6",
      },
      [
        "node",
        "agenc",
        "--provider",
        "openai",
        "--model",
        "daemon-default",
        "--yolo",
        "daemon",
        "run",
      ],
    );
    expect(argv.filter((entry) => entry === "--model")).toHaveLength(1);
    expect(argv[argv.indexOf("--model") + 1]).toBe("grok-4.6");
    expect(argv[argv.indexOf("--provider") + 1]).toBe("grok");
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("plan");
    expect(argv).not.toContain("--yolo");
    expect(argv).not.toContain("daemon-default");
    expect(argv).not.toContain("daemon");
  });
});
