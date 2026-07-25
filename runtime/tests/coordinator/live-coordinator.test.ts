/**
 * Task 10: coordinator mode promoted onto the LIVE tool surface.
 * Previously the mode was env-gated onto the retired classic
 * Agent/SendMessage stack; the live registry and the live system
 * prompt never changed. These tests pin the first-class resolution
 * (config flag + env override), the live-tool prompt, and the
 * allowlist restriction semantics the bootstrap applies.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  getLiveCoordinatorSystemPrompt,
  isCoordinatorModeEnabled,
  LIVE_COORDINATOR_ALLOWED_TOOLS,
} from "./coordinatorMode.js";
import { toolConfigAllowsTool } from "../tools/config.js";
import { coordinatorCommand } from "../commands/coordinator.js";
import type { Session } from "../session/session.js";
import type { SlashCommandContext } from "../commands/types.js";

afterEach(() => {
  delete process.env.AGENC_COORDINATOR_MODE;
});

describe("isCoordinatorModeEnabled", () => {
  it("uses the config flag when the env var is unset", () => {
    expect(isCoordinatorModeEnabled(true)).toBe(true);
    expect(isCoordinatorModeEnabled(false)).toBe(false);
    expect(isCoordinatorModeEnabled(undefined)).toBe(false);
  });

  it("env var overrides in both directions", () => {
    process.env.AGENC_COORDINATOR_MODE = "1";
    expect(isCoordinatorModeEnabled(false)).toBe(true);
    process.env.AGENC_COORDINATOR_MODE = "0";
    expect(isCoordinatorModeEnabled(true)).toBe(false);
    process.env.AGENC_COORDINATOR_MODE = "off";
    expect(isCoordinatorModeEnabled(true)).toBe(false);
  });
});

describe("live coordinator surface", () => {
  it("the prompt references the live orchestration tools, not the retired stack", () => {
    const prompt = getLiveCoordinatorSystemPrompt();
    expect(prompt).toContain("spawn_agent");
    expect(prompt).toContain("send_message");
    expect(prompt).toContain("wait_agent");
    expect(prompt).toContain("give an idle reusable worker a new task");
    expect(prompt).not.toContain("give a running worker a new task");
    expect(prompt).not.toContain("SendMessageTool");
    // Coordinator never edits directly.
    expect(prompt).toContain("do NOT edit files or run commands yourself");
  });

  it("the allowlist admits orchestration tools and rejects edit/shell tools", () => {
    const toolsConfig = {
      enabled_tools: [...LIVE_COORDINATOR_ALLOWED_TOOLS],
    };
    for (const allowed of ["spawn_agent", "send_message", "wait_agent", "TaskStop", "AskUserQuestion"]) {
      expect(toolConfigAllowsTool(toolsConfig, allowed)).toBe(true);
    }
    for (const denied of ["Edit", "Write", "exec_command", "system.bash", "apply_patch"]) {
      expect(toolConfigAllowsTool(toolsConfig, denied)).toBe(false);
    }
  });
});

describe("/coordinator command", () => {
  function mkctx(argsRaw: string, configFlag?: boolean): SlashCommandContext {
    return {
      session: {} as unknown as Session,
      argsRaw,
      cwd: "/ws",
      home: "/home/test",
      configStore: {
        current: () => ({ coordinator_mode: configFlag }),
      },
    } as unknown as SlashCommandContext;
  }

  it("reports status including the effective state and toggle usage", async () => {
    const result = await coordinatorCommand.execute(mkctx("", true));
    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).toContain("Coordinator mode: ON");
      expect(result.text).toContain("/coordinator on");
    }
    const off = await coordinatorCommand.execute(mkctx(""));
    if (off.kind === "text") {
      expect(off.text).toContain("Coordinator mode: off");
    }
  });

  it("rejects unknown arguments", async () => {
    const result = await coordinatorCommand.execute(mkctx("sideways"));
    expect(result.kind).toBe("error");
  });
});
